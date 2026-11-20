// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
// Behavior tests for coord/engine/scripts/token-economics.js — the cost-ledger,
// precheck, context-pack, tier-policy, plan-waves, and dispatch-plan levers
// (TOKEN_ECONOMICS.md). Relocated verbatim from governance.test.js by COORD-096
// (residual facade split, slice 1): module-owned unit behavior is exercised
// through createTokenEconomics; command integration stays on executeCommand.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const { executeCommand, __testing } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance.js"));
const createTokenEconomics = require("./token-economics.js");
const { COORD_DIR, DEFAULT_PATHS, state } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-context.js"));
const { resolveEngineModule } = require("../../paths.js");
const tokenEconomics = createTokenEconomics({
  isRepoBackedCode: (code) => Boolean(code && code !== "X" && DEFAULT_PATHS.repoRoots[code]),
  relativeCoordPath: (filePath) => path.relative(COORD_DIR, filePath).split(path.sep).join("/"),
});
const { withCanonicalTicketPrompt, withScopedGovernanceTestContext } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { renderDispatchCachePrefix, buildDispatchCachePrefixMarker } = require(resolveEngineModule(COORD_DIR, "scripts/dispatch-context.js"));
const { evidenceRef, applyInvariantRetraction } = require(resolveEngineModule(COORD_DIR, "scripts/plan-evidence-supersession.js"));

function createIsolatedCostLifecycleFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord772-cli-lifecycle-"));
  const coord = path.join(root, "coord");
  const backend = path.join(root, "backend");
  fs.mkdirSync(coord, { recursive: true });
  fs.mkdirSync(backend, { recursive: true });
  const sourceCoord = path.resolve(__dirname, "..", "..");
  for (const name of ["scripts", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "product", "prompts", "schemas", "docs", "agents.json"]) {
    const source = path.join(sourceCoord, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(coord, name), {
      recursive: true,
      filter: (entry) => !/\.test\.js$/.test(entry) && !path.relative(source, entry).split(path.sep).some((part) => [".runtime", ".worktrees", "node_modules"].includes(part)),
    });
  }
  require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/coord-engine-schemas.js")).installCanonicalEngine(coord, sourceCoord,
    (entry) => !/\.test\.js$/.test(entry) && !path.relative(path.join(sourceCoord, "engine"), entry).split(path.sep).some((part) => [".runtime", ".worktrees", "node_modules"].includes(part)));

  const ticket = "COST-772";
  const owner = "codexa772";
  const branch = `agent/${owner}-${ticket.toLowerCase()}`;
  const worktree = path.join(backend, ".worktrees", owner, ticket);
  const cliPath = path.join(coord, "scripts", "governance.js");
  const configPath = path.join(coord, "project.config.js");
  fs.writeFileSync(configPath, `module.exports = { coordTicketPrefix: "COORD", repos: { B: { path: "${backend}", integrationBranch: "dev", origin: null, legacyAliases: [], ticketPrefixes: ["COST"], testCommand: "true" } }, requirements: { path: "product/REQUIREMENTS.md" } };\n`);
  const baseEnv = { ...process.env, COORD_PROJECT_CONFIG: configPath, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["COORD_SESSION_ID", "COORD_PROVIDER_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "GEMINI_THREAD_ID", "GROK_THREAD_ID", "AGENT_THREAD_ID", "GOVERNANCE_MCP_THREAD_ID"]) delete baseEnv[key];
  const ownerEnv = { ...baseEnv, CLAUDE_SESSION_ID: "coord772-owner-thread" };
  const run = (cwd, command, args, env = baseEnv) => spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 60000 });
  const git = (cwd, ...args) => {
    const result = run(cwd, "git", ["-C", cwd, ...args]);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
    return String(result.stdout || "").trim();
  };
  const cli = (env, ...args) => run(root, process.execPath, [cliPath, ...args], env);
  const ok = (env, ...args) => {
    const result = cli(env, ...args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };

  git(backend, "init", "-b", "dev");
  git(backend, "config", "user.email", "coord772@example.test");
  git(backend, "config", "user.name", "COORD-772 fixture");
  git(backend, "config", "maintenance.autoDetach", "false");
  fs.writeFileSync(path.join(backend, "seed.txt"), "fixture baseline\n");
  git(backend, "add", "seed.txt");
  git(backend, "commit", "-m", "seed COORD-772 lifecycle fixture");
  const remote = path.join(root, "backend-origin.git");
  git(root, "init", "--bare", "-b", "dev", remote);
  git(backend, "remote", "add", "origin", remote);
  git(backend, "push", "origin", "dev");
  const row = { ID: ticket, Repo: "B", Type: "bug", Pri: "P2", Status: "todo", Owner: "", Description: "COORD-772 phase observation lifecycle regression", "Depends On": "" };
  writeJson(path.join(coord, "board", "tasks.json"), {
    version: 1,
    metadata: { title: "COORD-772 lifecycle fixture", last_updated: new Date().toISOString(), canonical_references: [], plan_markdown_render_statuses: ["doing", "review"], preamble: [], plan_records_required_from_ticket: { B: "MSRV-999" }, landing_index_required_from_ticket: { B: "MSRV-999" }, pr_index_required_from_ticket: { B: "MSRV-999" }, feature_proof_required_from_ticket: { B: "MSRV-999" } },
    sections: [{ kind: "table", level: 2, heading: "COORD-772", separator_before: false, columns: Object.keys(row), rows: [row] }],
    prompt_index: { [ticket]: "coord/prompts/tickets/COST-772.md" }, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {}, waiver_index: {},
  });
  fs.mkdirSync(path.join(coord, "prompts", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(coord, "prompts", "tickets", "COST-772.md"), "# COST-772\n\n## Acceptance\n\n- Record honest per-phase cost observations through the lifecycle.\n");
  fs.writeFileSync(path.join(coord, "PLAN.md"), "");
  fs.writeFileSync(path.join(coord, "QUESTIONS.md"), "# Questions\n");
  fs.mkdirSync(path.join(coord, ".runtime", "locks"), { recursive: true });
  fs.mkdirSync(path.join(coord, ".runtime", "plans"), { recursive: true });
  writeJson(path.join(coord, ".runtime", "agents.json"), [{ id: "a772", handle: owner, provider: "anthropic", status: "active", aliases: [], lane: "backend", default_repo: "B", created_at: new Date().toISOString() }]);
  writeJson(path.join(coord, ".runtime", "agent_sessions.json"), []);
  const evalCode = (code) => {
    const result = run(root, process.execPath, ["-e", code], baseEnv);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result;
  };
  evalCode(`require(${JSON.stringify(path.join(coord, "scripts", "governance.js"))}).__testing.ensureGovernanceJournalBaseline("COORD-772 isolated lifecycle fixture");`);
  return { root, coord, backend, remote, ticket, owner, branch, worktree, cliPath, baseEnv, ownerEnv, run, git, cli, ok, writeJson, evalCode };
}

// ---------------------------------------------------------------------------
// COORD-026: cost-ledger (TOKEN_ECONOMICS.md lever #1).
// ---------------------------------------------------------------------------

const COST_PRICE_FIXTURE = {
  schema_version: 1,
  currency: "USD",
  unit: "per_1m_tokens",
  models: {
    small: { input: 0.25, output: 1.25 },
    standard: { input: 3.0, output: 15.0 },
    frontier: { input: 15.0, output: 75.0 },
  },
  default: { input: 99.0, output: 99.0 },
};

function withCostLedgerEnv(prefix, board, fn) {
  const coordRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtimeDir = path.join(coordRoot, ".runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const boardPath = path.join(coordRoot, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  const pricesPath = path.join(coordRoot, "model-prices.json");
  fs.writeFileSync(pricesPath, JSON.stringify(COST_PRICE_FIXTURE, null, 2), "utf8");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");

  return withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
    MODEL_PRICES_PATH: pricesPath,
    LOCKS_DIR: path.join(runtimeDir, "locks"),
  }, () => {
    // COORD-835: the seeded board starts journaled (a lost-journal genesis over it now refuses).
    __testing.ensureGovernanceJournalBaseline("COORD-026 cost ledger fixture");
    return fn({ coordRoot, boardPath, pricesPath, eventLogPath });
  });
}

const COST_BOARD = {
  metadata: { title: "Cost Ledger Test Board" },
  sections: [
    {
      rows: [
        { ID: "C-001", Repo: "X", Status: "doing", Owner: "concord1", Description: "ledger ticket" },
        { ID: "C-002", Repo: "X", Status: "doing", Owner: "concord1", Description: "second ticket" },
      ],
    },
  ],
};

test("COORD-026: readModelPrices loads the data-driven table; resolveModelPrice matches exact then default", () => {
  withCostLedgerEnv("cost-prices-", COST_BOARD, () => {
    const prices = tokenEconomics.readModelPrices();
    assert.equal(prices.models.standard.input, 3.0);
    assert.equal(tokenEconomics.resolveModelPrice("standard", prices).matched, "standard");
    assert.equal(tokenEconomics.resolveModelPrice("STANDARD", prices).matched, "standard", "case-insensitive");
    const unknown = tokenEconomics.resolveModelPrice("totally-unknown-model", prices);
    assert.equal(unknown.matched, "default", "unknown model falls back to default, never zero");
    assert.equal(unknown.rate.input, 99.0);
  });
});

test("COORD-026: estimateCostUsd computes USD = in/1M*inRate + out/1M*outRate", () => {
  withCostLedgerEnv("cost-est-", COST_BOARD, () => {
    const prices = tokenEconomics.readModelPrices();
    const est = tokenEconomics.estimateCostUsd("standard", 1_000_000, 500_000, prices);
    // 1M*$3/1M + 0.5M*$15/1M = 3 + 7.5
    assert.equal(est.usd, 10.5);
    assert.equal(est.priced_by, "standard");
  });
});

test("COORD-026: record-cost happy path appends a cost.observed event with attribution", () => {
  withCostLedgerEnv("cost-record-", COST_BOARD, ({ eventLogPath }) => {
    const result = executeCommand([
      "record-cost", "C-001",
      "--agent", "concord1",
      "--model", "standard",
      "--input-tokens", "200000",
      "--output-tokens", "100000",
      "--phase", "implement",
    ]);
    assert.equal(result.ok, true, result.error || result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.event_type, "cost.observed");
    assert.equal(payload.ticket, "C-001");
    assert.equal(payload.agent, "concord1");
    assert.equal(payload.usd_estimated, true);
    // 0.2M*$3 + 0.1M*$15 = 0.6 + 1.5
    assert.equal(payload.usd, 2.1);

    const journal = fs.readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const costEvent = journal.find((e) => e.details && e.details.event_type === "cost.observed");
    assert.ok(costEvent, "cost.observed event must be present in the journal");
    assert.equal(costEvent.command, "record-cost");
    assert.equal(costEvent.details.cost.input_tokens, 200000);
  });
});

test("COORD-026: record-cost honors explicit --usd and validates numeric fields", () => {
  withCostLedgerEnv("cost-usd-", COST_BOARD, () => {
    const explicit = executeCommand([
      "record-cost", "C-001", "--agent", "a", "--model", "small",
      "--input-tokens", "10", "--output-tokens", "20", "--usd", "0.5",
    ]);
    assert.equal(explicit.ok, true, explicit.error);
    const payload = JSON.parse(explicit.stdout);
    assert.equal(payload.usd, 0.5);
    assert.equal(payload.usd_estimated, false);

    const badTokens = executeCommand([
      "record-cost", "C-001", "--model", "small",
      "--input-tokens", "-5", "--output-tokens", "20",
    ]);
    assert.equal(badTokens.ok, false);
    assert.match(badTokens.error, /non-negative integer/);

    const badUsd = executeCommand([
      "record-cost", "C-001", "--model", "small",
      "--input-tokens", "5", "--output-tokens", "20", "--usd", "-1",
    ]);
    assert.equal(badUsd.ok, false);
    assert.match(badUsd.error, /--usd must be a non-negative number/);

    const noModel = executeCommand([
      "record-cost", "C-001", "--input-tokens", "5", "--output-tokens", "20",
    ]);
    assert.equal(noModel.ok, false);
    assert.match(noModel.error, /requires --model/);
  });
});

test("COORD-772: record-cost missing-ticket refusal and implicit-agent fallback stay safe", () => {
  withCostLedgerEnv("cost-attribution-fallback-", COST_BOARD, ({ eventLogPath }) => {
    const missingTicket = executeCommand(["record-cost"]);
    assert.equal(missingTicket.ok, false);
    assert.match(missingTicket.error, /record-cost requires <ticket-id>/);
    const initialEvents = fs.readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(initialEvents.some((event) => event.details?.event_type === "cost.observed"), false,
      "a missing ticket id must refuse before appending an observation");

    // Use private identity registries so this test is independent of whichever
    // agents happen to be active in the host checkout or clean clone.
    const threadEnvNames = [
      "COORD_SESSION_ID", "COORD_PROVIDER_SESSION_ID", "CODEX_THREAD_ID",
      "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "GEMINI_THREAD_ID",
      "GROK_THREAD_ID", "AGENT_THREAD_ID", "GOVERNANCE_MCP_THREAD_ID",
    ];
    const previousThreadEnv = Object.fromEntries(threadEnvNames.map((name) => [name, process.env[name]]));
    const identityFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cost-attribution-identity-"));
    const identityRegistryPaths = {
      AGENTS_PATH: path.join(identityFixtureRoot, "agents.json"),
      LEGACY_AGENTS_PATH: path.join(identityFixtureRoot, "legacy-agents.json"),
      AGENT_SESSIONS_PATH: path.join(identityFixtureRoot, "agent_sessions.json"),
      LEGACY_AGENT_SESSIONS_PATH: path.join(identityFixtureRoot, "legacy-agent_sessions.json"),
    };
    try {
      for (const name of threadEnvNames) delete process.env[name];
      withScopedGovernanceTestContext(identityRegistryPaths, () => {
        fs.writeFileSync(identityRegistryPaths.AGENTS_PATH, "[]\n", "utf8");
        fs.writeFileSync(identityRegistryPaths.LEGACY_AGENTS_PATH, "[]\n", "utf8");
        fs.writeFileSync(identityRegistryPaths.AGENT_SESSIONS_PATH, "[]\n", "utf8");
        fs.writeFileSync(identityRegistryPaths.LEGACY_AGENT_SESSIONS_PATH, "[]\n", "utf8");
        const withoutAgentFlag = executeCommand([
          "record-cost", "C-001", "--model", "small", "--input-tokens", "0", "--output-tokens", "0",
        ]);
        assert.equal(withoutAgentFlag.ok, true, withoutAgentFlag.error);
        assert.equal(JSON.parse(withoutAgentFlag.stdout).agent, null,
          "without --agent or an active claimed identity, agent attribution stays unknown");

        const sessionsPath = identityRegistryPaths.AGENT_SESSIONS_PATH;
        const activeAgent = {
          id: "a77",
          handle: "codexa77",
          aliases: ["codex77"],
          provider: "openai",
          status: "active",
          notes: "COORD-772 isolated attribution test identity",
          created_at: "2026-10-23T00:00:00.000Z",
        };
        fs.writeFileSync(identityRegistryPaths.AGENTS_PATH, `${JSON.stringify([activeAgent], null, 2)}\n`, "utf8");
        const identityThreadId = "cost-attribution-fallback-thread";
        const now = new Date().toISOString();
        fs.writeFileSync(sessionsPath, `${JSON.stringify([{
          session_id: "cost-attribution-fallback-session",
          agent_id: activeAgent.id,
          handle: activeAgent.handle,
          board_path: state.BOARD_PATH,
          thread_id: identityThreadId,
          claimed_at: now,
          last_seen_at: now,
          status: "active",
          auto_claimed: false,
        }], null, 2)}\n`, "utf8");
        process.env.CODEX_THREAD_ID = identityThreadId;
        const agentsOnDisk = JSON.parse(fs.readFileSync(state.AGENTS_PATH, "utf8"));
        const sessionsOnDisk = JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"));
        assert.equal(agentsOnDisk.some((agent) => agent.handle === activeAgent.handle), true);
        assert.equal(sessionsOnDisk.some((session) => session.thread_id === identityThreadId), true);
        const inferredAgent = executeCommand([
          "record-cost", "C-002", "--model", "small", "--input-tokens", "0", "--output-tokens", "0",
        ]);
        assert.equal(inferredAgent.ok, true, inferredAgent.error);
        assert.equal(JSON.parse(inferredAgent.stdout).agent, activeAgent.handle,
          "without --agent, a claimed session supplies the agent handle through the normal CLI path");
      });
    } finally {
      for (const name of threadEnvNames) {
        if (previousThreadEnv[name] === undefined) delete process.env[name];
        else process.env[name] = previousThreadEnv[name];
      }
      fs.rmSync(identityFixtureRoot, { recursive: true, force: true });
    }
  });
});

test("COORD-772: cost report preserves a missing legacy event timestamp as unknown", () => {
  withCostLedgerEnv("cost-missing-event-time-", COST_BOARD, ({ eventLogPath }) => {
    const measured = executeCommand([
      "record-cost", "C-001", "--agent", "ledger-test", "--model", "small",
      "--input-tokens", "1", "--output-tokens", "0",
    ]);
    assert.equal(measured.ok, true, measured.error);
    const events = fs.readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const costEvent = events.find((event) => event.details?.event_type === "cost.observed");
    assert.ok(costEvent, "fixture has a normally recorded cost event");
    delete costEvent.ts; // emulate a sparse historical event; reader accepts JSON entries without ts
    fs.writeFileSync(eventLogPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const report = executeCommand(["cost", "--by", "agent", "--json"]);
    assert.equal(report.ok, true, report.error);
    const payload = JSON.parse(report.stdout);
    assert.equal(payload.totals.observations, 1);
    assert.equal(payload.totals.input_tokens, 1);
    assert.equal(payload.breakdown.find((entry) => entry.key === "ledger-test").observations, 1,
      "the public cost path retains a sparse legacy event rather than dropping it or inventing metadata");
  });
});

test("COORD-026: cost report aggregates by ticket/agent/model over a seeded ledger", () => {
  withCostLedgerEnv("cost-report-", COST_BOARD, () => {
    executeCommand(["record-cost", "C-001", "--agent", "alice", "--model", "standard", "--input-tokens", "1000000", "--output-tokens", "0"]);
    executeCommand(["record-cost", "C-001", "--agent", "bob", "--model", "small", "--input-tokens", "1000000", "--output-tokens", "0"]);
    executeCommand(["record-cost", "C-002", "--agent", "alice", "--model", "standard", "--input-tokens", "1000000", "--output-tokens", "0"]);

    const byTicket = JSON.parse(executeCommand(["cost", "--by", "ticket", "--json"]).stdout);
    assert.equal(byTicket.totals.observations, 3);
    assert.equal(byTicket.totals.usd, 3.0 + 0.25 + 3.0);
    const c001 = byTicket.breakdown.find((b) => b.key === "C-001");
    assert.equal(c001.observations, 2);
    assert.equal(c001.usd, 3.25);

    const byAgent = JSON.parse(executeCommand(["cost", "--by", "agent", "--json"]).stdout);
    const alice = byAgent.breakdown.find((b) => b.key === "alice");
    assert.equal(alice.observations, 2);
    assert.equal(alice.usd, 6.0);

    const byModel = JSON.parse(executeCommand(["cost", "--by", "model", "--json"]).stdout);
    const standard = byModel.breakdown.find((b) => b.key === "standard");
    assert.equal(standard.observations, 2);

    const filtered = JSON.parse(executeCommand(["cost", "--ticket", "C-002", "--json"]).stdout);
    assert.equal(filtered.totals.observations, 1);
  });
});

test("COORD-772: real CLI dispatch start, review, and landed closeout retain simulated provider observations by ticket/agent/model/phase", (t) => {
  const f = createIsolatedCostLifecycleFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const dispatchPath = path.join(f.coord, "engine", "scripts", "dispatch.mjs");
  const manifestResult = f.run(f.root, process.execPath, [dispatchPath, "--repo", "B", "--execution-id", "coord772-test-run", "--json"], f.baseEnv);
  assert.equal(manifestResult.status, 0, `${manifestResult.stdout}\n${manifestResult.stderr}`);
  const manifest = JSON.parse(manifestResult.stdout);
  const entry = manifest.waves.flatMap((wave) => wave.tickets).find((ticket) => ticket.ticket_id === f.ticket || ticket.ticket === f.ticket);
  assert.ok(entry, `dispatch manifest must include ${f.ticket}`);
  const executionId = entry.dispatch_execution_id;
  assert.ok(executionId, "dispatch must bind a stable ticket execution identity");

  f.ok(f.ownerEnv, "agentid", "--owner", f.owner);
  f.ok(f.ownerEnv, "plan", f.ticket, "--seed");
  f.ok(f.ownerEnv, "start", f.ticket, "--owner", f.owner, "--dispatch-execution-id", executionId);
  const planPath = path.join(f.coord, ".runtime", "plans", `${f.ticket}.json`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const lenses = ["contract/state invariants", "auth/security/failure modes", "tests/operability/performance", "requirement closure"];
  plan.startup_checklist = ["isolated fixture context inspected"];
  plan.traceability_gate = ["exempt"];
  plan.baseline_reproduction = ["not-required"];
  plan.intended_files = ["backend/fixture-change.txt"];
  plan.change_summary = ["Exercise lifecycle-bound cost observations with simulated provider telemetry."];
  plan.verification_commands = ["node --test coord/scripts/token-economics.test.js"];
  plan.critical_invariants = ["Unknown lifecycle boundaries are not provider measurements.", "Provider records and lifecycle records survive landing."];
  plan.requirement_closure = ["Ticket ask: exercise actual lifecycle with phase observations", "Implemented: lifecycle and attributable cost evidence", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"];
  plan.repo_gates = ["true — fixture repository gate passed"];
  plan.self_review_cycles = lenses.map((lens, index) => ({ cycle: index + 1, total: 4, lens, diff: "isolated CLI fixture", risks: ["identity binding", "publication"], findings: "none", verification: "focused COORD-772 regression", verdict: "pass", raw: `lens=${lens}; diff=fixture; risks=identity, publication; findings=none; verification=focused test; verdict=pass` }));
  f.writeJson(planPath, plan);
  f.evalCode(`const g=require(${JSON.stringify(path.join(f.coord, "scripts", "governance.js"))}).__testing;const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},"utf8"));g.writePlanCompatibilityBlockFromRecord(${JSON.stringify(f.ticket)},p);g.advanceGovernanceProvenanceBaseline("COORD-772 test plan ready");`);

  // This callback is deliberately simulated test telemetry: the repository has
  // no live provider usage callback. Counts are explicit fixture values, not a
  // claim about a real provider response.
  const record = (phase, attempt, input, output) => f.ok(f.ownerEnv, "record-cost", f.ticket,
    "--agent", f.owner, "--model", "small", "--dispatch-execution-id", executionId,
    "--attempt-id", `simulated-provider:${attempt}`, "--phase", phase,
    "--input-tokens", String(input), "--output-tokens", String(output),
    "--measurement-source", "provider_reported");
  record("plan", "plan-attempt-1", 0, 17);
  const source = path.join(f.worktree, "fixture-change.txt");
  fs.writeFileSync(source, "landed fixture evidence\n");
  f.git(f.worktree, "add", "fixture-change.txt");
  f.ok(f.ownerEnv, "commit", f.ticket, "--message", "COORD-772 fixture implementation");
  record("implement", "implementation-attempt-1", 31, 9);
  f.ok(f.ownerEnv, "move-review", f.ticket, "--owner", f.owner, "--pr", "local-review (no PR)");
  const featureBranch = f.git(f.worktree, "branch", "--show-current");
  f.git(f.backend, "checkout", "dev");
  f.git(f.backend, "merge", "--no-ff", featureBranch, "-m", "Land COORD-772 fixture");
  f.git(f.backend, "push", "origin", "dev");
  const landingSha = f.git(f.backend, "rev-parse", "dev");
  record("review", "review-attempt-1", 7, 2);
  f.ok(f.ownerEnv, "finalize", f.ticket, "--no-pr", "--already-landed", "--landed", `${landingSha} Merged implementation into dev and pushed to the isolated local origin`, "--base", "dev");

  const journal = fs.readFileSync(path.join(f.coord, ".runtime", "governance-events.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const observations = journal.filter((event) => event.ticket === f.ticket && event.details?.event_type === "cost.observed").map((event) => event.details.cost);
  assert.equal(observations.length, 6, "three measured callback records plus plan, implement, and landing lifecycle boundaries remain journalled");
  assert.ok(observations.every((cost) => cost.dispatch_execution_id === executionId), "all phase observations retain the dispatch execution identity");
  assert.ok(observations.every((cost) => cost.ticket === f.ticket && cost.agent === f.owner), "observations retain ticket and agent attribution");
  assert.deepEqual(new Set(observations.filter((cost) => cost.measurement_source === "provider_reported").map((cost) => cost.phase)), new Set(["plan", "implement", "review"]));
  assert.ok(observations.filter((cost) => cost.measurement_source === "lifecycle_boundary").every((cost) => cost.measurement_status === "unknown"));
  assert.equal(f.git(f.remote, "rev-parse", "refs/heads/dev"), f.git(f.backend, "rev-parse", "dev"), "fixture landing is present on the local bare origin");
  const reportByTicket = JSON.parse(f.ok(f.ownerEnv, "cost", "--by", "ticket", "--ticket", f.ticket, "--json").stdout);
  assert.equal(reportByTicket.breakdown[0].key, f.ticket);
  assert.equal(reportByTicket.breakdown[0].observations, 6, "cost report retains measured observations and explicit unknown lifecycle boundaries");
  assert.deepEqual(reportByTicket.totals.provenance.measurement_sources, { lifecycle_boundary: 3, provider_reported: 3 });
  assert.deepEqual(reportByTicket.breakdown[0].provenance.usd_provenance, { documented_rate_card: 3, unavailable: 3 });
  assert.deepEqual(reportByTicket.totals.provenance.priced_by, { small: 3 }, "reported pricing provenance is retained in the JSON report");
  assert.deepEqual(reportByTicket.totals.provenance.unknown_reasons, { provider_usage_unavailable_at_lifecycle_boundary: 3 });
  assert.deepEqual(reportByTicket.totals.provenance.usd_unknown_reasons, { usage_counters_unavailable: 3 });
  const reportByAgent = JSON.parse(f.ok(f.ownerEnv, "cost", "--by", "agent", "--ticket", f.ticket, "--json").stdout);
  assert.ok(reportByAgent.breakdown.some((entry) => entry.key === f.owner));
  const reportByModel = JSON.parse(f.ok(f.ownerEnv, "cost", "--by", "model", "--ticket", f.ticket, "--json").stdout);
  assert.ok(reportByModel.breakdown.some((entry) => entry.key === "small"));
  const reportByPhase = JSON.parse(f.ok(f.ownerEnv, "cost", "--by", "phase", "--ticket", f.ticket, "--json").stdout);
  assert.deepEqual(new Set(reportByPhase.breakdown.map((entry) => entry.key)), new Set(["plan", "implement", "review"]));
  const plainCostReport = f.ok(f.ownerEnv, "cost", "--by", "phase", "--ticket", f.ticket);
  assert.match(plainCostReport.stdout, /Cost ledger \(by phase/);
  assert.match(plainCostReport.stdout, /plan:/, "human-readable report retains its phase buckets after landing");
  const explain = f.ok(f.ownerEnv, "explain", f.ticket, "--json");
  assert.match(explain.stdout, /cost_phase_advisory|cost.*advisory/i, "ticket explain keeps phase coverage visible after landing");
});

test("COORD-026: cost report is hash-stable and preserves unknown totals for an empty ledger", () => {
  // An empty ledger has no evidence for a measured zero.
  withCostLedgerEnv("cost-empty-", COST_BOARD, () => {
    const empty = executeCommand(["cost", "--json"]);
    assert.equal(empty.ok, true);
    const payload = JSON.parse(empty.stdout);
    assert.equal(payload.totals.observations, 0);
    assert.equal(payload.totals.input_tokens, null);
    assert.equal(payload.totals.output_tokens, null);
    assert.equal(payload.totals.usd, null);
    assert.deepEqual(payload.totals.provenance.measurement_sources, {});
    assert.deepEqual(payload.breakdown, []);
    const humanEmpty = executeCommand(["cost"]);
    assert.match(humanEmpty.stdout, /\(empty ledger\)/, "non-JSON empty reports identify the empty ledger");
  });

  // Two independent ledgers seeded with identical observations produce
  // byte-identical --json output (deterministic ordering, no timestamps).
  const seed = (env) => {
    executeCommand(["record-cost", "C-002", "--agent", "bob", "--model", "small", "--input-tokens", "10", "--output-tokens", "10"]);
    executeCommand(["record-cost", "C-001", "--agent", "alice", "--model", "standard", "--input-tokens", "10", "--output-tokens", "10"]);
    return executeCommand(["cost", "--by", "ticket", "--json"]).stdout;
  };
  const a = withCostLedgerEnv("cost-stableA-", COST_BOARD, seed);
  const b = withCostLedgerEnv("cost-stableB-", COST_BOARD, seed);
  assert.equal(a, b, "identical ledgers must produce byte-identical --json packs");
});

test("COORD-772: dispatch observation retries are idempotent, conflicts refuse, and new attempts remain distinct", () => {
  withCostLedgerEnv("cost-dispatch-idempotency-", COST_BOARD, ({ eventLogPath, pricesPath }) => {
    const command = (inputTokens, attemptId = "provider-1", extra = []) => [
      "record-cost", "C-001", "--model", "standard", "--phase", "implement",
      "--dispatch-execution-id", "exec-772", "--attempt-id", attemptId,
      "--measurement-source", "provider_reported", "--usage-scope", "phase_delta",
      "--input-tokens", String(inputTokens), "--output-tokens", "0",
      ...extra,
    ];
    const first = executeCommand(command(1_000_000));
    assert.equal(first.ok, true);
    assert.equal(JSON.parse(first.stdout).usd, 3);
    const changedRateCard = JSON.parse(fs.readFileSync(pricesPath, "utf8"));
    changedRateCard.models.standard.input = 19;
    fs.writeFileSync(pricesPath, JSON.stringify(changedRateCard));
    const replay = executeCommand(command(1_000_000));
    assert.equal(replay.ok, true, "same caller payload replays after rate-card changes");
    changedRateCard.models.standard = null;
    fs.writeFileSync(pricesPath, JSON.stringify(changedRateCard));
    assert.equal(executeCommand(command(1_000_000)).ok, true, "malformed pricing evidence cannot conflict with an identical replay");
    const conflict = executeCommand(command(6));
    assert.equal(conflict.ok, false);
    assert.match(conflict.error || conflict.stderr, /Conflicting cost observation/);
    assert.equal(executeCommand(command(7, "provider-retry-2")).ok, true);

    const explicit = command(1, "explicit-price", ["--usd", "0.25"]);
    assert.equal(executeCommand(explicit).ok, true);
    const explicitConflict = executeCommand(command(1, "explicit-price", ["--usd", "0.26"]));
    assert.equal(explicitConflict.ok, false, "caller-supplied USD is part of the observation payload");
    assert.match(explicitConflict.error || explicitConflict.stderr, /Conflicting cost observation/);

    fs.rmSync(pricesPath);
    const unavailable = executeCommand(command(10, "rate-added-later"));
    assert.equal(unavailable.ok, true);
    assert.equal(JSON.parse(unavailable.stdout).usd, null);
    fs.writeFileSync(pricesPath, JSON.stringify(COST_PRICE_FIXTURE));
    const nowPricedReplay = executeCommand(command(10, "rate-added-later"));
    assert.equal(nowPricedReplay.ok, true, "later-added rate does not turn the same unknown-price usage into a conflict");

    const events = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map(JSON.parse)
      .filter((event) => event.result === "succeeded" && event.details?.event_type === "cost.observed");
    assert.equal(events.length, 4, "pricing changes never add replay duplicates; new attempts and explicit-price attempts remain distinct");
    const firstRecorded = events.find((event) => event.details.cost.attempt_id === "provider-1").details.cost;
    assert.equal(firstRecorded.usd, 3, "the original derived price remains immutable on replay");
    const latePriced = events.find((event) => event.details.cost.attempt_id === "rate-added-later").details.cost;
    assert.equal(latePriced.usd, null, "the original unavailable price remains unknown on replay");
    const humanReport = executeCommand(["cost", "--by", "phase", "--ticket", "C-001"]);
    assert.match(humanReport.stdout, /Cost ledger \(by phase/);
    assert.match(humanReport.stdout, /implement:/, "non-JSON reports render phase buckets");
  });
});

test("COORD-772: unsafe dispatch identities are refused before a ledger event is written", () => {
  withCostLedgerEnv("cost-dispatch-invalid-identity-", COST_BOARD, ({ eventLogPath }) => {
    for (const [flag, value] of [["--dispatch-execution-id", "exec has space"], ["--attempt-id", "../attempt"]]) {
      const otherFlag = flag === "--attempt-id" ? ["--dispatch-execution-id", "exec-safe"] : ["--attempt-id", "attempt-safe"];
      const result = executeCommand([
        "record-cost", "C-001", "--model", "standard", "--phase", "implement",
        flag, value, ...otherFlag, "--input-tokens", "1", "--output-tokens", "0",
      ]);
      assert.equal(result.ok, false, `${flag} rejects unsafe values`);
      assert.match(result.error || result.stderr, /safe identifier characters/);
    }
    assert.equal(fs.readFileSync(eventLogPath, "utf8").trim().split("\n").length, 1, "only the fixture provenance baseline exists");
  });
});

test("COORD-772: record-cost refuses incomplete attribution, malformed scope, and unknown-ticket observations", () => {
  withCostLedgerEnv("cost-dispatch-refusals-", COST_BOARD, ({ eventLogPath }) => {
    const cases = [
      ["dispatch identity requires execution, attempt, and phase", ["record-cost", "C-001", "--dispatch-execution-id", "exec-only"], /requires --dispatch-execution-id, --attempt-id, and --phase/],
      ["legacy observations require both counters", ["record-cost", "C-001", "--model", "standard", "--input-tokens", "1"], /requires --input-tokens and --output-tokens/],
      ["attributed missing counters require an explicit reason", ["record-cost", "C-001", "--dispatch-execution-id", "exec-missing", "--attempt-id", "attempt-missing", "--phase", "plan", "--input-tokens", "1"], /Missing token values require --unknown-reason/],
      ["usage scope vocabulary is closed", ["record-cost", "C-001", "--dispatch-execution-id", "exec-scope", "--attempt-id", "attempt-scope", "--phase", "plan", "--unknown-reason", "missing counters", "--usage-scope", "rolling"], /--usage-scope must be one of/],
      ["cumulative usage requires dispatch attribution", ["record-cost", "C-001", "--model", "standard", "--input-tokens", "1", "--output-tokens", "1", "--usage-scope", "execution_cumulative"], /require dispatch execution and attempt identity/],
      ["measurement-source vocabulary is closed", ["record-cost", "C-001", "--dispatch-execution-id", "exec-source", "--attempt-id", "attempt-source", "--phase", "plan", "--model", "standard", "--input-tokens", "1", "--output-tokens", "1", "--measurement-source", "inferred"], /--measurement-source must be one of/],
      ["legacy phase vocabulary is validated", ["record-cost", "C-001", "--model", "standard", "--input-tokens", "1", "--output-tokens", "1", "--phase", "not-a-phase"], /--phase must be one of/],
      ["unknown tickets cannot write observations", ["record-cost", "C-772-MISSING", "--dispatch-execution-id", "exec-unknown-ticket", "--attempt-id", "attempt-unknown-ticket", "--phase", "plan", "--model", "standard", "--input-tokens", "1", "--output-tokens", "1"], /Unknown ticket "C-772-MISSING"/],
    ];
    for (const [label, args, expected] of cases) {
      const result = executeCommand(args);
      assert.equal(result.ok, false, label);
      assert.match(result.error || result.stderr || "", expected, label);
    }
    const successfulObservations = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map(JSON.parse)
      .filter((event) => event.result === "succeeded" && event.details?.event_type === "cost.observed");
    assert.deepEqual(successfulObservations, [], "refused payloads never become successful cost observations");
  });
});

test("COORD-772: attributed USD requires explicit price evidence and never falls back to a default rate", () => {
  withCostLedgerEnv("cost-attributed-price-provenance-", COST_BOARD, ({ eventLogPath, pricesPath }) => {
    const record = (attemptId, extra = []) => executeCommand([
      "record-cost", "C-001", "--phase", "plan", "--dispatch-execution-id", "exec-price-check",
      "--attempt-id", attemptId, "--input-tokens", "10", "--output-tokens", "20", ...extra,
    ]);
    assert.equal(record("missing-model").ok, true);
    assert.equal(record("unmatched-model", ["--model", "vendor-model-unlisted"]).ok, true);
    assert.equal(record("known-rate", ["--model", "standard"]).ok, true);
    const longerPrefix = JSON.parse(JSON.stringify(COST_PRICE_FIXTURE));
    longerPrefix.models = {
      standard: { input: 0.25, output: 1.25 },
      "standard-v2-long": { input: 0.5, output: 2 },
    };
    fs.writeFileSync(pricesPath, JSON.stringify(longerPrefix));
    assert.equal(record("prefix-rate-longer-replaces", ["--model", "standard-v2"]).ok, true);
    const longerPrefixFirst = { ...longerPrefix, models: {
      "standard-v2-long": { input: 0.5, output: 2 },
      standard: { input: 0.25, output: 1.25 },
    } };
    fs.writeFileSync(pricesPath, JSON.stringify(longerPrefixFirst));
    assert.equal(record("prefix-rate-longest-retained", ["--model", "standard-v2"]).ok, true);
    assert.equal(record("explicit-usd", ["--usd", "0.02"]).ok, true);
    fs.unlinkSync(pricesPath);
    assert.equal(record("missing-price-table", ["--model", "standard"]).ok, true);

    const observations = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map(JSON.parse)
      .filter((event) => event.result === "succeeded" && event.details?.event_type === "cost.observed")
      .map((event) => event.details.cost);
    const byAttempt = Object.fromEntries(observations.map((cost) => [cost.attempt_id, cost]));
    for (const attempt of ["missing-model", "unmatched-model", "missing-price-table"]) {
      assert.equal(byAttempt[attempt].usd, null, `${attempt} cannot borrow a default fallback price`);
      assert.equal(byAttempt[attempt].usd_provenance, "unavailable");
      assert.ok(byAttempt[attempt].usd_unknown_reason);
    }
    assert.equal(byAttempt["known-rate"].usd, 0.00033);
    assert.equal(byAttempt["known-rate"].usd_provenance, "documented_rate_card");
    assert.equal(byAttempt["known-rate"].priced_by, "standard");
    assert.equal(byAttempt["prefix-rate-longer-replaces"].priced_by, "standard-v2-long", "a later longer matching model prefix replaces the shorter entry");
    assert.equal(byAttempt["prefix-rate-longest-retained"].priced_by, "standard-v2-long", "a later shorter matching model prefix cannot replace the longest entry");
    assert.equal(byAttempt["explicit-usd"].usd, 0.02);
    assert.equal(byAttempt["explicit-usd"].usd_provenance, "explicit_measurement");
    assert.equal(byAttempt["explicit-usd"].usd_estimated, false);

    const malformedCases = [
      ["null-rate-object", null],
      ["null-input-rate", { input: null, output: 1.25 }],
      ["blank-output-rate", { input: 0.25, output: " " }],
    ];
    for (const [attempt, rate] of malformedCases) {
      const table = JSON.parse(JSON.stringify(COST_PRICE_FIXTURE));
      table.models.standard = rate;
      fs.writeFileSync(pricesPath, JSON.stringify(table));
      assert.equal(record(attempt, ["--model", "standard"]).ok, true, `${attempt} preserves token evidence instead of throwing`);
    }
    const zeroTable = JSON.parse(JSON.stringify(COST_PRICE_FIXTURE));
    zeroTable.models.standard = { input: 0, output: 0 };
    fs.writeFileSync(pricesPath, JSON.stringify(zeroTable));
    assert.equal(record("valid-zero-rate", ["--model", "standard"]).ok, true);

    const afterMalformed = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map(JSON.parse)
      .filter((event) => event.result === "succeeded" && event.details?.event_type === "cost.observed")
      .map((event) => event.details.cost);
    const malformed = Object.fromEntries(afterMalformed.map((cost) => [cost.attempt_id, cost]));
    for (const [attempt] of malformedCases) {
      assert.equal(malformed[attempt].usd, null, `${attempt} is unavailable rather than a fabricated zero price`);
      assert.equal(malformed[attempt].usd_provenance, "unavailable");
    }
    assert.equal(malformed["valid-zero-rate"].usd, 0, "an explicitly documented numeric zero rate is a valid free price");
    assert.equal(malformed["valid-zero-rate"].usd_provenance, "documented_rate_card");
  });
});

test("COORD-772: malformed price-reader errors and lifecycle boundary write failures stay advisory", () => {
  const createCostObservations = require("./cost-observations.js");
  const throwingPrices = createCostObservations({
    fail(message) { throw new Error(message); },
    readModelPrices() { throw new Error("unreadable rate table"); },
  });
  assert.equal(throwingPrices.priceAttributedUsage("standard", 10, 20).usd, null,
    "a rate-reader exception leaves the token measurement intact and price unknown");
  assert.throws(() => throwingPrices.parseNonNegativeInteger("--input-tokens", undefined),
    /requires a non-negative integer/, "missing numeric inputs fail explicitly rather than becoming zero");
  const unattributedBucket = throwingPrices.aggregateCost([{
    ticket: "C-001", agent: null, model: "standard", phase: "plan",
    input_tokens: 1, output_tokens: 2, usd: null, measurement_status: "measured", usage_scope: "phase_delta",
  }], "agent");
  assert.equal(unattributedBucket[0].key, "(unattributed)", "agent reports preserve observations with missing identity");
  const unboundBoundary = createCostObservations({
    readGovernanceEventLog: () => [],
    recordCost() { throw new Error("no dispatch should not write a lifecycle observation"); },
  });
  assert.doesNotThrow(() => unboundBoundary.recordLifecycleCostBoundary("C-001", "plan", ["start"]),
    "tickets without a successful dispatch start have no lifecycle cost identity to record");
  const incompleteBoundary = createCostObservations({
    readGovernanceEventLog: () => [{ ticket: "C-001", command: "start", result: "succeeded", ts: "2026-10-23T00:00:00Z", details: { dispatch_execution_id: "exec-boundary" } }],
    recordCost() { throw new Error("no matching phase transition should not write a boundary"); },
  });
  assert.doesNotThrow(() => incompleteBoundary.recordLifecycleCostBoundary("C-001", "implement", ["move-review"]),
    "a bound execution without the phase-completion event has no boundary observation yet");

  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (warning) => warnings.push(String(warning));
  try {
    const failingBoundary = createCostObservations({
      readGovernanceEventLog: () => [{ ticket: "C-001", command: "start", result: "succeeded", ts: "2026-10-23T00:00:00Z", details: { dispatch_execution_id: "exec-boundary" } }],
      recordCost() { throw new Error("simulated ledger write failure"); },
    });
    assert.doesNotThrow(() => failingBoundary.recordLifecycleCostBoundary("C-001", "plan", ["start"]));
    const nonErrorBoundary = createCostObservations({
      readGovernanceEventLog: () => [{ ticket: "C-001", command: "start", result: "succeeded", ts: "2026-10-23T00:00:00Z", details: { dispatch_execution_id: "exec-boundary" } }],
      recordCost() { throw {}; },
    });
    assert.doesNotThrow(() => nonErrorBoundary.recordLifecycleCostBoundary("C-001", "plan", ["start"]));
  } finally {
    console.warn = previousWarn;
  }
  assert.match(warnings[0] || "", /Cost observation advisory failed for C-001\/plan: simulated ledger write failure/);
  assert.match(warnings[1] || "", /Cost observation advisory failed for C-001\/plan: \[object Object\]/,
    "non-Error thrown values still produce a useful warning instead of blocking lifecycle completion");
});

test("COORD-772: sparse legacy observations retain report fallbacks and cumulative snapshot ordering", () => {
  const createCostObservations = require("./cost-observations.js");
  const fail = (message) => { throw new Error(message); };
  const sparse = [{
    ticket: null, agent: null, model: null, phase: null,
    input_tokens: null, output_tokens: null, usd: null,
    measurement_status: "measured",
  }];
  const helper = createCostObservations({ fail, collectCostObservations: () => sparse });
  assert.equal(helper.aggregateCost(sparse, "agent")[0].key, "(unattributed)");
  assert.equal(helper.aggregateCost(sparse, "model")[0].key, "(unknown)");
  assert.equal(helper.aggregateCost(sparse, "phase")[0].key, "(unspecified)");
  assert.equal(helper.aggregateCost(sparse, "other")[0].key, "(none)");
  assert.equal(helper.aggregateCost(sparse, "ticket")[0].unknown_observations, 1,
    "null counters remain unknown even when a legacy status field says measured");
  assert.deepEqual(helper.aggregateCost(sparse, "ticket")[0].provenance, {
    measurement_sources: { "(unspecified)": 1 },
    usd_provenance: { "(unspecified)": 1 },
    priced_by: {},
    unknown_reasons: { "(unspecified)": 1 },
    usd_unknown_reasons: { "(unspecified)": 1 },
    usage_scopes: { phase_delta: 1 },
  }, "legacy sparse records expose honest provenance fallbacks and the compatible delta scope");
  const hostileLabels = ["__proto__", "constructor", "toString"];
  const hostileObservations = hostileLabels.map((label) => ({
    ticket: "C-001", agent: "agent", model: "model", phase: "plan",
    input_tokens: 1, output_tokens: 1, usd: null, priced_by: label,
    measurement_status: "unknown", measurement_source: "provider_reported",
    usd_provenance: "unavailable", unknown_reason: label, usd_unknown_reason: label,
    usage_scope: "phase_delta",
  }));
  const hostileHelper = createCostObservations({ fail, collectCostObservations: () => hostileObservations });
  const savedConsoleLog = console.log;
  let hostileOutput = "";
  console.log = (line) => { hostileOutput = String(line); };
  try {
    hostileHelper.costReport({ by: "ticket", json: true });
  } finally {
    console.log = savedConsoleLog;
  }
  const hostileReport = JSON.parse(hostileOutput);
  for (const field of ["priced_by", "unknown_reasons", "usd_unknown_reasons"]) {
    for (const label of hostileLabels) assert.equal(hostileReport.totals.provenance[field][label], 1, `${field} safely counts ${label}`);
  }
  const lexicalBuckets = helper.aggregateCost(["phase-a-2", "phase-a", "phase-a-10", "Phase-a", "phase-ab"].map((agent) => ({
    ticket: "C-001", agent, input_tokens: 1, output_tokens: 1, usd: null,
    measurement_status: "measured", usage_scope: "phase_delta",
  })), "agent");
  assert.deepEqual(lexicalBuckets.map((bucket) => bucket.key), ["Phase-a", "phase-a", "phase-a-10", "phase-a-2", "phase-ab"],
    "bucket keys retain deterministic UTF-16 lexical ordering, including shared prefixes");
  assert.throws(() => helper.costReport({ by: "not-a-dimension" }), /cost --by must be one of/);
  const originalLog = console.log;
  const sparseLines = [];
  console.log = (line) => sparseLines.push(String(line));
  try {
    helper.costReport({ by: "agent" });
  } finally {
    console.log = originalLog;
  }
  assert.match(sparseLines.join("\n"), /unknown in \+ unknown out tokens, unknown/,
    "human-readable totals preserve unknown counters and unknown USD");
  assert.match(sparseLines.join("\n"), /\(unattributed\): 1 obs, unknown in \/ unknown out, unknown/,
    "human-readable bucket details preserve unknown counters and unknown USD");

  const snapshots = [
    { ticket: "C-001", phase: null, input_tokens: 1, output_tokens: 0, usd: 0.1, measurement_status: "measured", usage_scope: "execution_cumulative" },
    { ticket: "C-001", phase: null, input_tokens: 2, output_tokens: 0, usd: 0.2, measurement_status: "measured", usage_scope: "execution_cumulative" },
    { ticket: "C-001", phase: null, input_tokens: 99, output_tokens: 0, usd: 9.9, measurement_status: "measured", usage_scope: "execution_cumulative", _observed_at: "2026-10-23T00:01:00Z" },
    { ticket: "C-001", phase: null, input_tokens: 100, output_tokens: 0, usd: 10, measurement_status: "measured", usage_scope: "execution_cumulative", _observed_at: "2026-10-23T00:00:00Z" },
  ];
  const snapshotsHelper = createCostObservations({ fail, collectCostObservations: () => snapshots });
  console.log = () => {};
  try {
    const report = snapshotsHelper.costReport({ by: "phase", json: true });
    assert.equal(report.scope_totals.execution_cumulative.executions, 1,
      "legacy snapshots without a dispatch ID group under their ticket/phase identity");
    assert.equal(report.scope_totals.execution_cumulative.input_tokens, 99,
      "the newest snapshot replaces the prior while an older late arrival is ignored");
  } finally {
    console.log = originalLog;
  }
});

test("COORD-772: unknown and measured-zero phase usage remain distinguishable", () => {
  withCostLedgerEnv("cost-dispatch-unknown-", COST_BOARD, ({ eventLogPath }) => {
    const unknown = executeCommand([
      "record-cost", "C-001", "--phase", "plan", "--dispatch-execution-id", "exec-unknown",
      "--attempt-id", "boundary:plan-1", "--measurement-source", "lifecycle_boundary",
      "--unknown-reason", "provider-usage-unavailable",
    ]);
    assert.equal(unknown.ok, true, unknown.error || unknown.stderr);
    const unknownEvent = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map(JSON.parse)
      .find((event) => event.details?.event_type === "cost.observed");
    assert.equal(unknownEvent.details.cost.input_tokens, null);
    assert.equal(unknownEvent.details.cost.output_tokens, null);
    const unknownOnlyReport = JSON.parse(executeCommand(["cost", "--by", "phase", "--ticket", "C-001", "--json"]).stdout);
    assert.equal(unknownOnlyReport.totals.input_tokens, null, "unknown is not represented as a zero total");
    assert.equal(unknownOnlyReport.totals.usd, null);
    const zero = executeCommand([
      "record-cost", "C-001", "--model", "standard", "--phase", "plan", "--dispatch-execution-id", "exec-unknown",
      "--attempt-id", "provider:plan-1", "--measurement-source", "provider_reported",
      "--input-tokens", "0", "--output-tokens", "0",
    ]);
    assert.equal(zero.ok, true, zero.error || zero.stderr);
    const partial = executeCommand([
      "record-cost", "C-001", "--phase", "implement", "--dispatch-execution-id", "exec-unknown",
      "--attempt-id", "provider:implement-partial", "--measurement-source", "provider_reported",
      "--input-tokens", "3", "--unknown-reason", "provider-output-counter-unavailable",
    ]);
    assert.equal(partial.ok, true, partial.error || partial.stderr);
    const report = JSON.parse(executeCommand(["cost", "--by", "phase", "--ticket", "C-001", "--json"]).stdout);
    const plan = report.breakdown.find((bucket) => bucket.key === "plan");
    assert.equal(plan.input_tokens, 0, "reported zero is retained as zero");
    assert.equal(plan.output_tokens, 0);
    assert.equal(plan.unknown_observations, 1, "unknown boundary evidence is counted separately");
    assert.equal(report.totals.unknown_observations, 1);
    const implement = report.breakdown.find((bucket) => bucket.key === "implement");
    assert.equal(implement.input_tokens, 3);
    assert.equal(implement.output_tokens, null);
    assert.equal(implement.unknown_output_observations, 1);
    assert.equal(implement.partial_observations, 1);
    const human = executeCommand(["cost", "--by", "phase", "--ticket", "C-001"]);
    assert.match(human.stdout, /coverage 1 measured\/1 partial\/1 unknown/,
      "human totals disclose mixed coverage instead of presenting sums as complete");
    assert.match(human.stdout, /source lifecycle_boundary=1, provider_reported=2/,
      "human totals include measurement-source provenance");
    assert.match(human.stdout, /unknown provider-output-counter-unavailable=1, provider-usage-unavailable=1/,
      "human totals include token unknown reasons");
  });
});

test("COORD-772: cumulative snapshots are latest-per-execution and combined-only usage stays unallocated", () => {
  withCostLedgerEnv("cost-dispatch-scopes-", COST_BOARD, () => {
    const record = (phase, attemptId, scope, input, output) => executeCommand([
      "record-cost", "C-001", "--model", "standard", "--phase", phase,
      "--dispatch-execution-id", "exec-scopes", "--attempt-id", attemptId,
      "--measurement-source", "provider_reported", "--usage-scope", scope,
      "--input-tokens", String(input), "--output-tokens", String(output),
    ]);
    assert.equal(record("plan", "cum-1", "execution_cumulative", 10, 2).ok, true);
    assert.equal(record("implement", "cum-2", "execution_cumulative", 25, 5).ok, true);
    assert.equal(record("review", "combined-1", "combined_only", 40, 8).ok, true);
    assert.equal(record("implement", "delta-1", "phase_delta", 3, 1).ok, true);
    const report = JSON.parse(executeCommand(["cost", "--by", "phase", "--json"]).stdout);
    assert.equal(report.totals.input_tokens, 3, "phase-delta totals exclude cumulative and combined scopes");
    assert.equal(report.scope_totals.execution_cumulative.input_tokens, 25, "latest cumulative snapshot is reported once");
    assert.equal(report.scope_totals.execution_cumulative.output_tokens, 5);
    assert.equal(report.scope_totals.combined_only.input_tokens, 40);
    assert.equal(report.breakdown.find((bucket) => bucket.key === "review").input_tokens, null);
  });
});

test("COORD-772: simulated adapter consumes dispatch callbacks and writes/report phases through the public command path", async () => {
  const executionId = "exec-simulated-772";
  const manifest = {
    schema_version: 1,
    cache_prefix: buildDispatchCachePrefixMarker([], []),
    wave_count: 1,
    waves: [{ wave: 1, tickets: [{
      ticket: "C-001", action: "spawn", suggested_model_class: "standard", tier: "standard",
      context_mode: "open", evidence_depth: { review_cycles: 3, feature_proofs: 0, critical_invariants: 0 },
    }] }],
    excluded: [],
  };
  const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord772-manifest-"));
  const manifestPath = path.join(manifestDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  let loop;
  try {
    const { pathToFileURL } = require("node:url");
    const dispatch = await import(pathToFileURL(path.join(__dirname, "dispatch.mjs")).href);
    const result = dispatch.runDispatch(["--json", "--manifest", manifestPath, "--execution-id", executionId]);
    assert.equal(result.status, 0, result.stderr);
    loop = JSON.parse(result.stdout);
  } finally {
    fs.rmSync(manifestDir, { recursive: true, force: true });
  }
  withCostLedgerEnv("cost-dispatch-integration-", COST_BOARD, () => {
      const callbacks = loop.waves[0].tickets[0].cost_phase_callbacks;
      const ticketExecutionId = loop.waves[0].tickets[0].dispatch_execution_id;
      assert.deepEqual(callbacks.map((callback) => callback.phase), ["plan", "implement", "review"]);

      // Deterministic fake adapter: consume each phase callback and submit
      // provider-reported usage via the same command dispatcher as gov CLI.
      for (const callback of callbacks) {
        const recorded = executeCommand([
          "record-cost", "C-001", "--agent", "adapter-test", "--model", "standard",
          "--dispatch-execution-id", ticketExecutionId, "--attempt-id", `provider:${callback.phase}:1`,
          "--measurement-source", "provider_reported", "--usage-scope", "phase_delta",
          "--phase", callback.phase, "--input-tokens", "10", "--output-tokens", "2",
        ]);
        assert.equal(recorded.ok, true, recorded.error || recorded.stderr);
      }
      // Replaying one callback after an interrupted adapter is one ledger event.
      assert.equal(executeCommand([
        "record-cost", "C-001", "--agent", "adapter-test", "--model", "standard",
        "--dispatch-execution-id", ticketExecutionId, "--attempt-id", "provider:implement:1",
        "--measurement-source", "provider_reported", "--usage-scope", "phase_delta",
        "--phase", "implement", "--input-tokens", "10", "--output-tokens", "2",
      ]).ok, true);
      const report = JSON.parse(executeCommand(["cost", "--by", "phase", "--ticket", "C-001", "--json"]).stdout);
      assert.equal(report.totals.observations, 3);
      assert.deepEqual(report.breakdown.map((bucket) => bucket.key), ["implement", "plan", "review"]);
      assert.equal(report.totals.input_tokens, 30);

      const explain = executeCommand(["explain", "C-001"]);
      assert.equal(explain.ok, true, explain.error || explain.stderr);
      const guidance = JSON.parse(explain.stdout).cost_phase_advisory;
      assert.equal(guidance.blocking, false);
      assert.deepEqual(guidance.executions[0].phases.map((phase) => phase.status), ["measured", "measured", "measured"]);
  });
});

test("COORD-772: lifecycle completion records an explicit unknown boundary without blocking or duplicating recovery", () => {
  const cliTesting = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/cli.js")).__testing;
  withCostLedgerEnv("cost-lifecycle-boundary-", COST_BOARD, ({ eventLogPath }) => {
    __testing.withGovernanceMutation({
      command: "start", ticket: "C-001", forceLog: true,
      details: { dispatch_execution_id: "exec-boundary-test" },
    }, () => {});
    assert.doesNotThrow(() => cliTesting.recordLifecycleCostBoundary("C-001", "plan", ["start"]));
    assert.doesNotThrow(() => cliTesting.recordLifecycleCostBoundary("C-001", "plan", ["start"]));
    const events = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map(JSON.parse)
      .filter((event) => event.result === "succeeded" && event.details?.event_type === "cost.observed");
    assert.equal(events.length, 1, "replaying a lifecycle completion records no second unknown observation");
    assert.equal(events[0].details.cost.measurement_status, "unknown");
    assert.equal(events[0].details.cost.measurement_source, "lifecycle_boundary");
    assert.equal(events[0].details.cost.input_tokens, null);
    assert.equal(events[0].details.cost.output_tokens, null);
  });
});

test("COORD-772: terminal lifecycle sync sees the review boundary before publication", () => {
  const cliTesting = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/cli.js")).__testing;
  withCostLedgerEnv("cost-terminal-sync-boundary-", COST_BOARD, ({ eventLogPath }) => {
    const appendLifecycleEvent = (command, details = {}) => __testing.appendGovernanceEvent({
      ts: new Date().toISOString(), command, ticket: "C-001",
      before_status: null, after_status: null, identity: null,
      result: "succeeded", details, changed_paths: [],
    });
    appendLifecycleEvent("start", { dispatch_execution_id: "exec-terminal-sync-test" });
    let syncObservedReview = false;
    const result = cliTesting.runTerminalLifecycle(
      "finalize", "C-001", {},
      () => {
        appendLifecycleEvent("mark-done");
        return { status: "done" };
      },
      {
        autoSyncAfterLifecycle: () => {
          const events = fs.readFileSync(eventLogPath, "utf8").trim().split("\n").map(JSON.parse);
          syncObservedReview = events.some((event) => event.result === "succeeded" &&
            event.details?.event_type === "cost.observed" && event.ticket === "C-001" &&
            event.details.cost.phase === "review" &&
            event.details.cost.dispatch_execution_id === "exec-terminal-sync-test");
          return { session_release_safe: true, publication: { status: "published", published: true } };
        },
        releaseTerminalTicketSession: () => ({ released: [] }),
      },
    );
    assert.deepEqual(result, { status: "done" });
    assert.equal(syncObservedReview, true, "the final review observation is present before the publication callback runs");
  });
});

test("COORD-026: the donor coord/product/model-prices.json is a valid data-driven price table", () => {
  const table = JSON.parse(fs.readFileSync("coord/product/model-prices.json", "utf8"));
  assert.ok(table.models && typeof table.models === "object", "must declare a models map");
  assert.ok(table.default && Number.isFinite(table.default.input) && Number.isFinite(table.default.output),
    "must declare a numeric default/unknown-model fallback");
});

// ---------------------------------------------------------------------------
// COORD-027: gov precheck (TOKEN_ECONOMICS.md lever #2).
// ---------------------------------------------------------------------------

test("COORD-027: classifyPrecheckVerdict maps probe pass counts to verdicts", () => {
  assert.equal(tokenEconomics.classifyPrecheckVerdict([]), "unknown", "no probes -> unknown (never a false satisfied)");
  assert.equal(tokenEconomics.classifyPrecheckVerdict([{ passed: true }, { passed: true }]), "already-satisfied");
  assert.equal(tokenEconomics.classifyPrecheckVerdict([{ passed: true }, { passed: false }]), "partial");
  assert.equal(tokenEconomics.classifyPrecheckVerdict([{ passed: false }, { passed: false }]), "not-started");
  assert.equal(tokenEconomics.classifyPrecheckVerdict([{ passed: false, error: "unavailable_ref" }]), "unknown");
});

test("COORD-027: runPrecheckProbe handles grep/file-exists and never throws", () => {
  // grep present against a real repo file.
  const grepHit = tokenEconomics.runPrecheckProbe({ type: "grep", pattern: "function precheck", path: "coord/engine/scripts/governance.js", expect: "present" });
  assert.equal(grepHit.passed, true);
  const grepMiss = tokenEconomics.runPrecheckProbe({ type: "grep", pattern: "this-string-does-not-exist-anywhere-xyzzy", path: "coord/engine/scripts/governance.js", expect: "present" });
  assert.equal(grepMiss.passed, false);
  // file-exists, both polarities.
  assert.equal(tokenEconomics.runPrecheckProbe({ type: "file-exists", path: "coord/engine/scripts/governance.js", expect: "present" }).passed, true);
  assert.equal(tokenEconomics.runPrecheckProbe({ type: "file-exists", path: "coord/scripts/does-not-exist.js", expect: "absent" }).passed, true);
  // Command probes require an explicit trusted invocation.
  assert.equal(tokenEconomics.runPrecheckProbe({ type: "test", command: "true" }).error, "command_probe_disabled");
  assert.equal(tokenEconomics.runPrecheckProbe({ type: "test", command: "true" }, { allowCommandProbes: true }).passed, true);
  assert.equal(tokenEconomics.runPrecheckProbe({ type: "test", command: "false" }, { allowCommandProbes: true }).passed, false);
  assert.equal(tokenEconomics.runPrecheckProbe({ type: "test", command: "false", expect: "fail" }, { allowCommandProbes: true }).passed, true);
  // malformed probes are reported, not thrown.
  const bad = tokenEconomics.runPrecheckProbe({ type: "grep" });
  assert.equal(bad.passed, false);
  assert.equal(bad.error, "schema");
  const unknownType = tokenEconomics.runPrecheckProbe({ type: "nonsense" });
  assert.equal(unknownType.passed, false);
});

test("COORD-685: command probes cannot execute by default or interpret shell operators when opted in", () => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord685-command-probe-"));
  const marker = path.join(markerDir, "marker");
  const command = `true; touch ${marker}`;
  try {
    const blocked = tokenEconomics.runPrecheckProbe({ type: "test", command });
    assert.equal(blocked.error, "command_probe_disabled");
    assert.equal(fs.existsSync(marker), false);
    const optedIn = tokenEconomics.runPrecheckProbe({ type: "test", command }, { allowCommandProbes: true });
    assert.equal(optedIn.passed, false);
    assert.equal(fs.existsSync(marker), false, "the command string must never be interpreted by a shell");
    const quoted = tokenEconomics.runPrecheckProbe({ type: "test", command: `${process.execPath} -e 'process.exit(0)'` }, { allowCommandProbes: true });
    assert.equal(quoted.passed, true, quoted.detail);
  } finally {
    fs.rmSync(markerDir, { recursive: true, force: true });
  }
});

test("COORD-685: grep treats attacker supplied regex syntax as bounded literal text", () => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord685-grep-probe-"));
  const file = path.join(probeDir, "probe.txt");
  try {
    fs.writeFileSync(file, `${"a".repeat(10000)}!`, "utf8");
    const result = tokenEconomics.runPrecheckProbe({ type: "grep", path: file, pattern: "(a+)+$" });
    assert.equal(result.passed, false);
    assert.equal(result.error, undefined);
    const tooLong = tokenEconomics.runPrecheckProbe({ type: "grep", path: file, pattern: "a".repeat(4097) });
    assert.equal(tooLong.error, "schema");
    const malformedMissing = tokenEconomics.runPrecheckProbe({ type: "grep", path: `${file}.missing`, pattern: "a".repeat(4097), expect: "absent" });
    assert.equal(malformedMissing.error, "schema", "a missing file must not turn an invalid probe into satisfied evidence");
    fs.writeFileSync(file, "a".repeat(1024 * 1024 + 1), "utf8");
    const oversized = tokenEconomics.runPrecheckProbe({ type: "grep", path: file, pattern: "a", expect: "absent" });
    assert.equal(oversized.error, "input_too_large", "oversized data must remain unknown, even for absence checks");
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
});

test("COORD-735: git-contains proves remote/ref ancestry and fails closed when unavailable", () => {
  // COORD-753: published cuts have one commit; never borrow donor history.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coord753-ancestry-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "fixture-main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("commit", "--allow-empty", "-m", "base");
    const ancestor = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-m", "child");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const probe = (commit, ref = "refs/remotes/origin/main") => tokenEconomics.runPrecheckProbe({ type: "git-contains", repo, ref, commit });
    const head = probe("HEAD");
    assert.equal(head.passed, true);
    assert.match(head.detail, /git-contains/);
    assert.equal(probe(ancestor).passed, true, "a real ancestor remains satisfied");
    const unavailable = probe("HEAD", "refs/remotes/not-present");
    assert.equal(unavailable.passed, false);
    assert.equal(unavailable.error, "unavailable_ref");
    assert.match(unavailable.detail, /unavailable/);
    git("checkout", "--orphan", "unrelated");
    git("commit", "--allow-empty", "-m", "unrelated");
    const nonAncestor = probe("HEAD");
    assert.equal(nonAncestor.passed, false, "an unrelated commit must not satisfy ancestry");
    assert.match(nonAncestor.detail, /confirmed non-ancestor/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function withTicketPrecheckSidecar(ticketId, board, probesJson, fn) {
  // COORD-290: precheck resolves probes from state.PROMPTS_DIR/tickets and the
  // board; provision a sandbox prompts dir + temp board so nothing touches the
  // live coord/prompts/tickets tree, then restore.
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "precheck-board-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  const promptsDir = path.join(tempBoard, "prompts");
  const ticketsDir = path.join(promptsDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  const sidecarPath = path.join(ticketsDir, `${ticketId}.precheck.json`);
  fs.writeFileSync(sidecarPath, probesJson, "utf8");

  const runtimeDir = path.join(tempBoard, ".runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const paths = {
    BOARD_PATH: boardPath,
    PROMPTS_DIR: promptsDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  };
  const priorExitCode = process.exitCode;
  return withScopedGovernanceTestContext(paths, () => {
    try {
      return fn();
    } finally {
      process.exitCode = priorExitCode;
    }
  });
}

const PRECHECK_BOARD = {
  metadata: { title: "Precheck Test Board" },
  sections: [{ rows: [{ ID: "PRE-001", Repo: "X", Status: "todo", Owner: "unassigned", Description: "precheck probe target" }] }],
};

test("COORD-685: declared command probes stay unknown in precheck and automatic dispatch", () => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord685-declared-command-"));
  const marker = path.join(markerDir, "marker");
  const probes = JSON.stringify({ probes: [{ type: "test", command: `touch ${marker}` }] });
  try {
    withTicketPrecheckSidecar("PRE-001", PRECHECK_BOARD, probes, () => {
      const precheck = executeCommand(["precheck", "PRE-001", "--json"]).value;
      assert.equal(precheck.verdict, "unknown");
      assert.equal(precheck.probes[0].error, "command_probe_disabled");
      const dispatch = executeCommand(["dispatch-plan", "--json"]).value;
      const dispatchTarget = dispatch.waves.flatMap((wave) => wave.tickets).find((ticket) => ticket.ticket === "PRE-001");
      assert.equal(dispatchTarget.action, "spawn");
      assert.match(dispatchTarget.reason, /unknown/);
      assert.equal(fs.existsSync(marker), false);
    });
  } finally {
    fs.rmSync(markerDir, { recursive: true, force: true });
  }
});

test("COORD-027: precheck verdict already-satisfied (exit 0) when all probes pass", () => {
  const probes = JSON.stringify({
    probes: [
      { type: "grep", pattern: "function precheck", path: "coord/engine/scripts/governance.js", expect: "present" },
      { type: "file-exists", path: "coord/engine/scripts/governance.js", expect: "present" },
    ],
  });
  withTicketPrecheckSidecar("PRE-001", PRECHECK_BOARD, probes, () => {
    const result = executeCommand(["precheck", "PRE-001", "--json"]);
    assert.equal(result.ok, true, result.error);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "already-satisfied");
    assert.equal(payload.exit_code, 0);
    assert.equal(payload.probes.length, 2);
  });
});

test("COORD-027: precheck verdict partial when some probes fail", () => {
  const probes = JSON.stringify({
    probes: [
      { type: "grep", pattern: "function precheck", path: "coord/engine/scripts/governance.js", expect: "present" },
      { type: "file-exists", path: "coord/scripts/this-does-not-exist.js", expect: "present" },
    ],
  });
  withTicketPrecheckSidecar("PRE-001", PRECHECK_BOARD, probes, () => {
    const payload = executeCommand(["precheck", "PRE-001", "--json"]).value;
    assert.equal(payload.verdict, "partial");
    assert.equal(payload.exit_code, 10);
  });
});

test("COORD-027: precheck verdict not-started when no probes pass", () => {
  const probes = JSON.stringify({
    probes: [{ type: "file-exists", path: "coord/scripts/this-does-not-exist.js", expect: "present" }],
  });
  withTicketPrecheckSidecar("PRE-001", PRECHECK_BOARD, probes, () => {
    const payload = executeCommand(["precheck", "PRE-001", "--json"]).value;
    assert.equal(payload.verdict, "not-started");
    assert.equal(payload.exit_code, 20);
  });
});

test("COORD-743: a failing/timing-out test probe is reported as unknown, not confirmed absence", () => {
  const probes = JSON.stringify({
    probes: [
      { type: "test", command: "exit 7" },
      { type: "test", command: "sleep 5", timeout_ms: 50 },
    ],
  });
  withTicketPrecheckSidecar("PRE-001", PRECHECK_BOARD, probes, () => {
    const result = executeCommand(["precheck", "PRE-001", "--json", "--allow-command-probes"]);
    assert.equal(result.ok, true, "probe failures must never throw");
    const payload = result.value;
    assert.equal(payload.verdict, "unknown");
    assert.equal(payload.exit_code, 30);
    const timed = payload.probes.find((p) => p.error === "timeout");
    assert.ok(timed, "the timed-out probe must be reported with an error, not thrown");
  });
});

test("COORD-027: no probes declared -> unknown (exit 30), never a false satisfied", () => {
  // Board ticket exists but there is no sidecar and no precheck block.
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "precheck-none-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify({
    metadata: { title: "B" },
    sections: [{ rows: [{ ID: "ARCH-001", Repo: "X", Status: "todo", Owner: "unassigned", Description: "no probes" }] }],
  }, null, 2), "utf8");
  const priorExit = process.exitCode;
  try {
    withScopedGovernanceTestContext({ BOARD_PATH: boardPath }, () => {
      // ARCH-001 has a real prompt on disk but (almost certainly) no precheck block.
      const payload = executeCommand(["precheck", "ARCH-001", "--json"]).value;
      assert.equal(payload.verdict, "unknown");
      assert.equal(payload.exit_code, 30);
      assert.equal(payload.probes.length, 0);
    });
  } finally {
    process.exitCode = priorExit;
  }
});

// ---------------------------------------------------------------------------
// COORD-028: gov context-pack (TOKEN_ECONOMICS.md lever #3).
// ---------------------------------------------------------------------------

test("COORD-028: parseTicketPromptSections mines files, acceptance criteria, and spec sections", () => {
  // Self-contained: provision a COORD-028 prompt declaring coord/scripts/governance.js,
  // 5 AC bullets, and a TOKEN_ECONOMICS.md / lever #3 spec reference, then mine it.
  const fixture = [
    "# COORD-028: context-pack",
    "",
    "- Priority: P2 · Spec of record: `coord/product/TOKEN_ECONOMICS.md` (lever #3)",
    "",
    "## Acceptance Criteria",
    "",
    "- AC one.",
    "- AC two.",
    "- AC three.",
    "- AC four.",
    "- AC five.",
    "",
    "## Likely Files",
    "- `coord/scripts/governance.js` (new verb)",
    "- governance test file",
    "",
  ].join("\n");
  withCanonicalTicketPrompt("COORD-028", fixture, () => {
    const parsed = tokenEconomics.parseTicketPromptSections("COORD-028");
    assert.ok(parsed.files.includes("coord/scripts/governance.js"), "declared file must be mined");
    assert.ok(parsed.acceptance_criteria.length >= 4, "AC bullets must be mined");
    assert.ok(parsed.spec_sections.includes("TOKEN_ECONOMICS.md"), "linked spec must be mined");
    assert.ok(parsed.spec_sections.some((s) => /lever #3/.test(s)), "lever marker must be mined");
  });
});

test("COORD-028: parseTicketPromptSections degrades to empty arrays for an unknown ticket", () => {
  const parsed = tokenEconomics.parseTicketPromptSections("NOPE-99999");
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.acceptance_criteria, []);
});

test("COORD-028: ticketFilesIntersect matches proof paths against ticket files", () => {
  assert.equal(tokenEconomics.ticketFilesIntersect(["coord/scripts/governance.js"], "coord/scripts/governance.js"), true);
  assert.equal(tokenEconomics.ticketFilesIntersect(["coord/scripts/governance.js"], "coord/scripts/other.js"), false);
});

function withContextPackPlanRecords(prefix, fn) {
  // Provision a temp PLAN_RECORDS_DIR with seeded landed plan records.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return withScopedGovernanceTestContext({ PLAN_RECORDS_DIR: dir }, () => fn(dir));
}

function withTempTicketPrompt(ticketId, promptText, fn) {
  // COORD-290: write the prompt into a sandbox PROMPTS_DIR (production resolves
  // prompts via state.PROMPTS_DIR) instead of the live coord/prompts tree.
  const tempPrompts = fs.mkdtempSync(path.join(os.tmpdir(), "temp-prompt-"));
  const ticketsDir = path.join(tempPrompts, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  fs.writeFileSync(path.join(ticketsDir, `${ticketId}.md`), promptText, "utf8");
  return withScopedGovernanceTestContext({ PROMPTS_DIR: tempPrompts }, fn);
}

function withContextPackBoard(board, fn) {
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "ctxpack-board-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  return withScopedGovernanceTestContext({ BOARD_PATH: boardPath }, fn);
}

const CTXPACK_PROMPT = [
  "# CTX-001: sample",
  "",
  "## Acceptance Criteria",
  "- first criterion",
  "- second criterion",
  "",
  "## Likely Files",
  "- `coord/scripts/governance.js` (the shared file)",
  "",
  "Spec of record: `TOKEN_ECONOMICS.md` (lever #3)",
].join("\n");

const CTXPACK_BOARD = {
  metadata: { title: "Context Pack Test Board" },
  sections: [{ rows: [
    { ID: "CTX-001", Repo: "X", Status: "todo", Owner: "unassigned", Description: "ctx ticket touching governance.js" },
    { ID: "CTX-NOFILE", Repo: "X", Status: "todo", Owner: "unassigned", Description: "ticket with no declared files" },
  ] }],
};

test("COORD-028: context-pack includes prior feature-proofs+invariants intersecting the ticket files", () => {
  withContextPackPlanRecords("ctxpack-plans-", (dir) => {
    // A landed record whose feature-proof touches coord/scripts/governance.js.
    const priorEvidence = { critical_invariants: ["the shared file invariant must hold", "retired timing probe"] };
    const retracted = applyInvariantRetraction(priorEvidence, {
      entry: evidenceRef("critical_invariant", 2, "retired timing probe"),
      reason: "The value was an evaluation probe, not an invariant.",
      actor: "codexa756",
      timestamp: "2026-10-05T19:30:00.000Z",
    }).record;
    fs.writeFileSync(path.join(dir, "PRIOR-001.json"), JSON.stringify({
      schema_version: 1,
      ticket_id: "PRIOR-001",
      feature_proof: ["symbol:coord/scripts/governance.js#someFn", "path:coord/other/file.js"],
      ...retracted,
    }), "utf8");
    // A landed record that does NOT touch the ticket files.
    fs.writeFileSync(path.join(dir, "PRIOR-002.json"), JSON.stringify({
      schema_version: 1,
      ticket_id: "PRIOR-002",
      feature_proof: ["path:frontend/app.tsx"],
      critical_invariants: ["unrelated invariant"],
    }), "utf8");

    withContextPackBoard(CTXPACK_BOARD, () => {
      withTempTicketPrompt("CTX-001", CTXPACK_PROMPT, () => {
        const pack = executeCommand(["context-pack", "CTX-001", "--json"]).value;
        assert.deepEqual(pack.ticket_specific.files, ["coord/scripts/governance.js"]);
        assert.equal(pack.ticket_specific.acceptance_criteria.length, 2);
        const proofTickets = pack.ticket_specific.prior_feature_proofs.map((p) => p.ticket);
        assert.ok(proofTickets.includes("PRIOR-001"), "intersecting proof must be included");
        assert.ok(!proofTickets.includes("PRIOR-002"), "non-intersecting proof must be excluded");
        assert.ok(pack.ticket_specific.prior_invariants.some((i) => i.ticket === "PRIOR-001"));
        assert.ok(pack.ticket_specific.prior_invariants.some((i) => i.invariant === "the shared file invariant must hold"));
        assert.ok(!pack.ticket_specific.prior_invariants.some((i) => i.invariant === "retired timing probe"),
          "context packs must not teach retired evidence as an active invariant");
        assert.ok(!pack.ticket_specific.prior_invariants.some((i) => i.ticket === "PRIOR-002"));
      });
    });
  });
});

test("COORD-807: context-pack mining skips the ticket's own, malformed and proofless records and survives an unreadable plan directory", () => {
  const mine = () => {
    let pack;
    withContextPackBoard(CTXPACK_BOARD, () => {
      withTempTicketPrompt("CTX-001", CTXPACK_PROMPT, () => {
        pack = executeCommand(["context-pack", "CTX-001", "--json"]).value;
      });
    });
    return pack.ticket_specific;
  };
  withContextPackPlanRecords("ctxpack-807-", (dir) => {
    const proof = ["symbol:coord/scripts/governance.js#someFn"];
    fs.writeFileSync(path.join(dir, "CTX-001.json"), JSON.stringify({
      ticket_id: "CTX-001", feature_proof: proof, critical_invariants: ["the ticket's own invariant is not prior art"],
    }), "utf8");
    fs.writeFileSync(path.join(dir, "PRIOR-BROKEN.json"), "{ not json", "utf8");
    fs.writeFileSync(path.join(dir, "PRIOR-NOPROOF.json"), JSON.stringify({
      ticket_id: "PRIOR-NOPROOF", feature_proof: "symbol:coord/scripts/governance.js#someFn",
      critical_invariants: ["a record without a proof list contributes nothing"],
    }), "utf8");
    fs.writeFileSync(path.join(dir, "PRIOR-OK.json"), JSON.stringify({
      ticket_id: "PRIOR-OK", feature_proof: proof, critical_invariants: ["mined invariant"],
    }), "utf8");
    const mined = mine();
    assert.deepEqual(mined.prior_feature_proofs, [{ ticket: "PRIOR-OK", proof: proof[0] }]);
    assert.deepEqual(mined.prior_invariants, [{ ticket: "PRIOR-OK", invariant: "mined invariant" }]);

    // A plan directory that does not exist, then one that exists but cannot
    // be listed: both mean "no prior evidence", never a crash or a guess.
    for (const unreadable of [path.join(dir, "absent"), path.join(dir, "PRIOR-OK.json")]) {
      withScopedGovernanceTestContext({ PLAN_RECORDS_DIR: unreadable }, () => {
        const empty = mine();
        assert.deepEqual(empty.prior_feature_proofs, []);
        assert.deepEqual(empty.prior_invariants, []);
      });
    }
  });
});

test("COORD-028: the stable/ticket split is present and the STABLE block is identical across tickets", () => {
  withContextPackPlanRecords("ctxpack-split-", () => {
    withContextPackBoard(CTXPACK_BOARD, () => {
      withTempTicketPrompt("CTX-001", CTXPACK_PROMPT, () => {
        const a = executeCommand(["context-pack", "CTX-001", "--json"]).value;
        const b = executeCommand(["context-pack", "CTX-NOFILE", "--json"]).value;
        assert.ok(a.stable && a.ticket_specific, "pack must split STABLE and TICKET-SPECIFIC");
        assert.deepEqual(a.stable, b.stable, "the STABLE block must be identical across tickets (cacheable prefix)");
        assert.notEqual(a.ticket_specific.ticket, b.ticket_specific.ticket);
      });
    });
  });
});

test("COORD-028: a no-prior-proof / no-files ticket still emits a valid pack (graceful degradation)", () => {
  withContextPackPlanRecords("ctxpack-empty-", () => {
    withContextPackBoard(CTXPACK_BOARD, () => {
      // CTX-NOFILE has no prompt on disk -> no files, no AC, no prior proofs.
      const result = executeCommand(["context-pack", "CTX-NOFILE", "--json"]);
      assert.equal(result.ok, true, result.error);
      const pack = result.value;
      assert.deepEqual(pack.ticket_specific.files, []);
      assert.deepEqual(pack.ticket_specific.prior_feature_proofs, []);
      assert.deepEqual(pack.ticket_specific.prior_invariants, []);
      assert.ok(pack.stable.shared_references.length > 0, "stable references still present");
    });
  });
});

test("COORD-028: context-pack --json is hash-stable for identical inputs", () => {
  withContextPackPlanRecords("ctxpack-stable-", (dir) => {
    fs.writeFileSync(path.join(dir, "PRIOR-001.json"), JSON.stringify({
      schema_version: 1, ticket_id: "PRIOR-001",
      feature_proof: ["symbol:coord/scripts/governance.js#fn"], critical_invariants: ["inv"],
    }), "utf8");
    withContextPackBoard(CTXPACK_BOARD, () => {
      withTempTicketPrompt("CTX-001", CTXPACK_PROMPT, () => {
        const a = executeCommand(["context-pack", "CTX-001", "--json"]).stdout;
        const b = executeCommand(["context-pack", "CTX-001", "--json"]).stdout;
        assert.equal(a, b, "identical inputs must produce byte-identical packs");
      });
    });
  });
});

test("COORD-771: context-pack degrades safely and renders available compact symbols", () => {
  const board = { metadata: { title: "Context Pack Edge Test" }, sections: [{ rows: [
    { ID: "CTX-771", Repo: "X", Status: "todo", Owner: "unassigned" },
    { ID: "CTX-771-EMPTY", Repo: "X", Status: "todo", Owner: "unassigned", Description: "No likely files" },
  ] }] };
  const prompt = [
    "# CTX-771: edge context pack",
    "## Acceptance Criteria",
    "- It keeps working when the code index is unavailable.",
    "## Likely Files",
    "- `coord/scripts/governance.js`",
    "Spec of record: `TOKEN_ECONOMICS.md` (lever #3)",
  ].join("\n");
  withContextPackPlanRecords("ctxpack-771-edges-", (dir) => {
    fs.writeFileSync(path.join(dir, "PRIOR-771.json"), JSON.stringify({
      schema_version: 1,
      ticket_id: "PRIOR-771",
      feature_proof: ["path:coord/scripts/governance.js"],
      critical_invariants: ["the shared governance surface remains read-only"],
    }), "utf8");
    withContextPackBoard(board, () => withTempTicketPrompt("CTX-771", prompt, () => {
      const codeContext = require("./code-context.js");
      const originalGetCompactViews = codeContext.getCompactViews;
      const originalLog = console.log;
      const output = [];
      const contextPack = (ticketId, options = {}) => {
        const result = executeCommand(["context-pack", ticketId, ...(options.json ? ["--json"] : [])]);
        output.push(result.stdout || "");
        if (!result.ok) throw new Error(result.error);
        return result.value;
      };
      try {
        console.log = (line) => output.push(String(line));
        assert.throws(() => contextPack("CTX-UNKNOWN", { json: true }), /Unknown ticket/);
        assert.throws(() => contextPack("", { json: true }), /requires <ticket-id>/);
        const jsonPack = contextPack("CTX-771", { json: true });
        assert.equal(jsonPack.ticket_specific.description, "", "missing optional descriptions render as empty text");
        assert.equal(jsonPack.ticket_specific.prior_feature_proofs[0].ticket, "PRIOR-771");
        assert.equal(jsonPack.ticket_specific.prior_invariants[0].invariant, "the shared governance surface remains read-only");
        const emptyFilesPack = contextPack("CTX-771-EMPTY");
        assert.deepEqual(emptyFilesPack.ticket_specific.files, []);
        assert.match(output.join("\n"), /- \(none declared\)/);

        codeContext.getCompactViews = () => [{
          path: "coord/scripts/governance.js", locs: 7, purpose: "Governance command entrypoint",
          exports: [{ kind: "function", line: 21, sig: "executeCommand(args)" }],
        }];
        const richPack = contextPack("CTX-771");
        assert.equal(richPack.ticket_specific.file_symbols.length, 1);
        assert.match(output.join("\n"), /File symbols \(compact/);
        assert.match(output.join("\n"), /Governance command entrypoint/);
        assert.match(output.join("\n"), /\[function:21\] executeCommand\(args\)/);
        assert.match(output.join("\n"), /TOKEN_ECONOMICS\.md/);

        output.length = 0;
        codeContext.getCompactViews = () => [{ path: "coord/scripts/undocumented.js", locs: 1, exports: [] }];
        const noPurposeSymbols = contextPack("CTX-771");
        assert.equal(noPurposeSymbols.ticket_specific.file_symbols[0].purpose, undefined);
        assert.doesNotMatch(output.join("\n"), /Governance command entrypoint/);

        output.length = 0;
        codeContext.getCompactViews = () => [];
        const emptySymbols = contextPack("CTX-771");
        assert.deepEqual(emptySymbols.ticket_specific.file_symbols, []);
        assert.doesNotMatch(output.join("\n"), /File symbols \(compact/);

        codeContext.getCompactViews = (files) => originalGetCompactViews(files,
          path.join(os.tmpdir(), `coord771-no-code-index-${process.pid}.ndjson`));
        const missingIndex = contextPack("CTX-771");
        assert.ok(Array.isArray(missingIndex.ticket_specific.file_symbols));
        assert.deepEqual(missingIndex.ticket_specific.file_symbols, [], "a missing code index produces the array contract's empty value");

        codeContext.getCompactViews = () => { throw new Error("index is unavailable"); };
        const unavailableIndex = contextPack("CTX-771");
        assert.deepEqual(unavailableIndex.ticket_specific.file_symbols, [], "an unavailable optional index does not break context-pack");
      } finally {
        codeContext.getCompactViews = originalGetCompactViews;
        console.log = originalLog;
      }
    }));
  });
});

// ---------------------------------------------------------------------------
// COORD-029: tier policy (TOKEN_ECONOMICS.md lever #4).
// ---------------------------------------------------------------------------

test("COORD-029: resolveTicketTier honors explicit Tier, derives from Pri, else defaults to standard", () => {
  const policy = tokenEconomics.readTierPolicy();
  assert.equal(tokenEconomics.resolveTicketTier({ Tier: "critical", Pri: "P3" }, policy).tier, "critical", "explicit Tier wins");
  assert.equal(tokenEconomics.resolveTicketTier({ Tier: "critical", Pri: "P3" }, policy).source, "explicit");
  assert.equal(tokenEconomics.resolveTicketTier({ Pri: "P3", Repo: "X" }, policy).tier, "mechanical", "P3 derives to mechanical");
  assert.equal(tokenEconomics.resolveTicketTier({ Pri: "P0" }, policy).tier, "critical", "P0 derives to critical");
  assert.equal(tokenEconomics.resolveTicketTier({ Pri: "P2" }, policy).tier, "standard");
  assert.equal(tokenEconomics.resolveTicketTier({}, policy).tier, "standard", "absent everything -> standard (safe default)");
});

test("COORD-029: standard and critical tiers keep TODAY's flat minimums byte-identical", () => {
  const productRow = { Repo: "B" };
  // Flat product minimum is 4 review cycles, 1 feature-proof, 2 invariants.
  assert.equal(tokenEconomics.effectiveTierMinimum("standard", "min_review_cycles", 4, productRow), 4, "standard never relaxes review cycles");
  assert.equal(tokenEconomics.effectiveTierMinimum("critical", "min_review_cycles", 4, productRow), 4, "critical never weakened");
  assert.equal(tokenEconomics.effectiveTierMinimum("standard", "min_feature_proofs", 1, productRow), 1);
  assert.equal(tokenEconomics.effectiveTierMinimum("critical", "min_critical_invariants", 2, productRow), 2);
});

test("COORD-029: mechanical tier relaxes BELOW the flat minimum (but never raises or goes negative)", () => {
  const productRow = { Repo: "B" };
  // mechanical policy: min_review_cycles=2, min_feature_proofs=0, min_critical_invariants=1.
  assert.equal(tokenEconomics.effectiveTierMinimum("mechanical", "min_review_cycles", 4, productRow), 2, "mechanical relaxes 4 -> 2");
  assert.equal(tokenEconomics.effectiveTierMinimum("mechanical", "min_feature_proofs", 1, productRow), 0);
  assert.equal(tokenEconomics.effectiveTierMinimum("mechanical", "min_critical_invariants", 2, productRow), 1);
  // Relax-only: if the flat value were already below the policy value, the flat wins (never raised).
  assert.equal(tokenEconomics.effectiveTierMinimum("mechanical", "min_review_cycles", 1, productRow), 1, "never raises above flat");
});

test("COORD-029: a policy that tries to weaken critical is ignored (critical pinned to flat)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-policy-"));
  const policyPath = path.join(dir, "tier-policy.json");
  // Adversarial: declare critical with a tiny minimum.
  fs.writeFileSync(policyPath, JSON.stringify({
    default_tier: "standard",
    derivation: { by_pri: { P0: "critical" } },
    tiers: {
      standard: { model_class: "standard", min_review_cycles: "today" },
      critical: { model_class: "frontier", min_review_cycles: 1, min_feature_proofs: 0, min_critical_invariants: 0 },
    },
  }), "utf8");
  withScopedGovernanceTestContext({ TIER_POLICY_PATH_OVERRIDE: policyPath }, () => {
    const productRow = { Repo: "B" };
    // Even with an adversarial policy, critical stays at the flat value.
    assert.equal(tokenEconomics.effectiveTierMinimum("critical", "min_review_cycles", 4, productRow), 4);
    assert.equal(tokenEconomics.effectiveTierMinimum("critical", "min_critical_invariants", 2, productRow), 2);
  });
});

test("COORD-029: gov tier reports resolved tier, suggested model, and required evidence depth", () => {
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "tier-board-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify({
    metadata: { title: "Tier Test Board" },
    sections: [{ rows: [
      { ID: "MECH-001", Repo: "X", Pri: "P3", Status: "todo", Owner: "unassigned", Description: "mechanical" },
      { ID: "CRIT-001", Repo: "B", Pri: "P0", Status: "todo", Owner: "unassigned", Description: "critical" },
    ] }],
  }, null, 2), "utf8");
  withScopedGovernanceTestContext({ BOARD_PATH: boardPath }, () => {
    const mech = executeCommand(["tier", "MECH-001"]).value;
    assert.equal(mech.tier, "mechanical");
    assert.equal(mech.suggested_model_class, "small");
    assert.equal(mech.required_evidence_depth.review_cycles, 2, "mechanical repo-X relaxes 3 -> 2");

    const crit = executeCommand(["tier", "CRIT-001"]).value;
    assert.equal(crit.tier, "critical");
    assert.equal(crit.suggested_model_class, "frontier");
    assert.equal(crit.required_evidence_depth.review_cycles, 4, "critical keeps the full product minimum");
    assert.equal(crit.required_evidence_depth.critical_invariants, 2);
  });
});

test("COORD-029: doctor enforces the relaxed minimum for a mechanical product ticket and full rigor for critical", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-doctor-"));
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({ version: 1, sections: [], review_findings: {}, pr_index: {}, landing_index: {} }, null, 2), "utf8");

  // A plan record with EXACTLY 2 structured passing review cycles, 1 invariant,
  // 0 feature-proofs, full requirement closure + a real repo gate.
  const lensCycles = [
    "lens=contract/state invariants; diff=d; risks=a, b; findings=none; verification=npm test; verdict=pass",
    "lens=auth/security/failure modes; diff=d; risks=a, b; findings=none; verification=npm test; verdict=pass",
  ];
  const seedRecord = (ticketId) => fs.writeFileSync(path.join(recordsDir, `${ticketId}.json`), JSON.stringify({
    schema_version: 1, ticket_id: ticketId, markdown_heading: `## ${ticketId}`,
    startup_checklist: ["completed"], traceability_gate: ["verified"], review_round: 1,
    baseline_reproduction: ["Command: npm test", "Outcome: reproduced"], prior_findings: [],
    intended_files: ["services/x.js"], change_summary: ["mechanical change"],
    verification_commands: ["npm test"],
    critical_invariants: ["the one mechanical invariant"],
    requirement_closure: ["Ticket ask: x", "Implemented: x", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["npm test"],
    self_review_cycles: lensCycles.map((raw, i) => ({ cycle: i + 1, total: lensCycles.length, raw, lens: raw.match(/lens=([^;]+)/)[1], diff: "d", risks: ["a", "b"], findings: "none", verification: "npm test", verdict: "pass" })),
    rollback_strategy: ["revert"], security_surface: "no", synced_from_markdown_at: "2026-06-10T00:00:00.000Z",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    // Mechanical product ticket (Pri P3): relaxed minimums (2 cycles, 0 proofs,
    // 1 invariant) -> the relaxed evidence passes the cycle-count gate.
    seedRecord("MECH-001");
    const mechIssues = __testing.collectReviewPlanReadinessIssues("MECH-001", { ID: "MECH-001", Repo: "B", Type: "feature", Pri: "P3" });
    assert.ok(!mechIssues.some((i) => i.code === "self_review_cycle_count"), "mechanical: 2 cycles must satisfy the relaxed minimum");
    assert.ok(!mechIssues.some((i) => i.code === "critical_invariants"), "mechanical: 1 invariant must satisfy the relaxed minimum");
    assert.ok(!mechIssues.some((i) => i.code === "feature_proof"), "mechanical: 0 feature-proofs allowed");

    // Critical product ticket (Pri P0): full rigor — the same 2-cycle/1-invariant
    // record must FAIL (needs 4 cycles + 2 invariants), proving critical is never weakened.
    seedRecord("CRIT-002");
    const critIssues = __testing.collectReviewPlanReadinessIssues("CRIT-002", { ID: "CRIT-002", Repo: "B", Type: "feature", Pri: "P0" });
    const critCodes = critIssues.map((i) => i.code);
    assert.ok(critCodes.includes("self_review_cycle_count"), "critical: 2 cycles must FAIL the 4-cycle minimum");
    assert.ok(critCodes.includes("critical_invariants"), "critical: 1 invariant must FAIL the 2-invariant minimum");
  });
});

test("COORD-029: the donor coord/product/tier-policy.json is a valid relax-only policy", () => {
  const policy = JSON.parse(fs.readFileSync("coord/product/tier-policy.json", "utf8"));
  assert.ok(policy.tiers.standard && policy.tiers.critical, "must define standard and critical tiers");
  // standard and critical must use the "today" sentinel (never a weakened number).
  assert.equal(policy.tiers.standard.min_review_cycles, "today");
  assert.equal(policy.tiers.critical.min_review_cycles, "today");
  // any non-standard/critical tier minimum must be a number (a relaxation).
  for (const [name, cfg] of Object.entries(policy.tiers)) {
    if (name === "standard" || name === "critical") continue;
    if (cfg.min_review_cycles !== undefined && cfg.min_review_cycles !== "today") {
      assert.ok(Number.isFinite(cfg.min_review_cycles), `${name}.min_review_cycles must be numeric`);
    }
  }
});

// ---------------------------------------------------------------------------
// COORD-030: gov plan-waves (TOKEN_ECONOMICS.md lever #5).
// ---------------------------------------------------------------------------

test("COORD-030: parseTicketDependsOn parses the Depends On column into ticket ids", () => {
  assert.deepEqual(tokenEconomics.parseTicketDependsOn({ "Depends On": "FOO-001, BAR-002" }), ["FOO-001", "BAR-002"]);
  assert.deepEqual(tokenEconomics.parseTicketDependsOn({ "Depends On": "" }), []);
  assert.deepEqual(tokenEconomics.parseTicketDependsOn({}), []);
});

function promptWithFiles(ticketId, files) {
  const lines = [`# ${ticketId}: sample`, "", "## Likely Files"];
  for (const f of files) {
    lines.push(`- \`${f}\` (a file)`);
  }
  return lines.join("\n");
}

function withPlanWavesScenario(board, promptsByTicket, fn) {
  // COORD-290: seed prompts into a sandbox PROMPTS_DIR instead of the live tree.
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "planwaves-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  const promptsDir = path.join(tempBoard, "prompts");
  const ticketsDir = path.join(promptsDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  for (const [ticketId, files] of Object.entries(promptsByTicket)) {
    fs.writeFileSync(path.join(ticketsDir, `${ticketId}.md`), promptWithFiles(ticketId, files), "utf8");
  }
  return withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PROMPTS_DIR: promptsDir }, () => {
    __testing.ensureGovernanceJournalBaseline("COORD-835: plan-waves fixture starts journaled");
    return fn({ boardPath, promptsDir, runtimeDir: state.RUNTIME_DIR });
  });
}

function findWaveOf(payload, ticket) {
  const w = payload.waves.find((wv) => wv.tickets.some((t) => t.ticket === ticket));
  return w ? w.wave : null;
}

test("COORD-030: two file-disjoint product tickets land in the same wave; file-sharing tickets split", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "WAVE-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "a", "Depends On": "" },
      { ID: "WAVE-002", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "b", "Depends On": "" },
      { ID: "WAVE-003", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "c", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "WAVE-001": ["src/a.js"],
    "WAVE-002": ["src/b.js"],       // disjoint from WAVE-001
    "WAVE-003": ["src/a.js"],       // shares src/a.js with WAVE-001
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    assert.equal(findWaveOf(payload, "WAVE-001"), 1);
    assert.equal(findWaveOf(payload, "WAVE-002"), 1, "file-disjoint ticket joins wave 1");
    assert.equal(findWaveOf(payload, "WAVE-003"), 2, "file-sharing ticket is pushed to a later wave");
  });
});

test("COORD-030: a dependsOn forces ordering across waves", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DEP-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "lead", "Depends On": "" },
      { ID: "DEP-002", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "follower", "Depends On": "DEP-001, DEP-003" },
      { ID: "DEP-003", Repo: "B", Pri: "P2", Status: "done", Owner: "", Description: "already done", "Depends On": "" },
    ] }],
  };
  const prompts = { "DEP-001": ["src/lead.js"], "DEP-002": ["src/follower.js"] };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    const w1 = findWaveOf(payload, "DEP-001");
    const w2 = findWaveOf(payload, "DEP-002");
    assert.ok(w2 > w1, "the dependent must be in a later wave than its dependency");
    const follower = payload.waves[w2 - 1].tickets.find((t) => t.ticket === "DEP-002");
    assert.deepEqual(follower.satisfied_deps, { "DEP-001": `wave ${w1}`, "DEP-003": "done" });
    assert.equal(findWaveOf(payload, "DEP-003"), null, "done dependencies consume no wave slot");
  });
});

test("COORD-351: safe repo-X tickets can share waves when declared files are disjoint", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "XSAFE-001", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "coord script", "Depends On": "" },
      { ID: "XSAFE-002", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "coord doc", "Depends On": "" },
      { ID: "XSAFE-003", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "coord overlap", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "XSAFE-001": ["coord/scripts/governance.js"],
    "XSAFE-002": ["coord/engine/docs/MULTI_AGENT_TOPOLOGIES.md"],
    "XSAFE-003": ["coord/scripts/governance.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    assert.equal(findWaveOf(payload, "XSAFE-001"), 1);
    assert.equal(findWaveOf(payload, "XSAFE-002"), 1, "safe disjoint repo-X ticket joins wave 1");
    assert.equal(findWaveOf(payload, "XSAFE-003"), 2, "overlapping safe repo-X ticket moves later");
    const safe = payload.waves[0].tickets.find((t) => t.ticket === "XSAFE-001");
    assert.equal(safe.parallelizable, true);
    assert.match(safe.note, /safe declared coord code\/doc surfaces/);
  });
});

test("COORD-355: board Declared Files unlock safe repo-X plan-waves without prompt prose", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      {
        ID: "XBOARD-001",
        Repo: "X",
        Pri: "P2",
        Status: "todo",
        Owner: "u",
        Description: "coord script",
        "Depends On": "",
        "Declared Files": "coord/scripts/sample-module.js",
      },
      {
        ID: "XBOARD-002",
        Repo: "X",
        Pri: "P2",
        Status: "todo",
        Owner: "u",
        Description: "coord doc",
        "Depends On": "",
        "Declared Files": "- `coord/engine/docs/MULTI_AGENT_TOPOLOGIES.md`",
      },
      {
        ID: "XBOARD-003",
        Repo: "X",
        Pri: "P2",
        Status: "todo",
        Owner: "u",
        Description: "coord overlap",
        "Depends On": "",
        declared_files: ["coord/scripts/sample-module.js"],
      },
    ] }],
  };
  withPlanWavesScenario(board, {}, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    assert.equal(findWaveOf(payload, "XBOARD-001"), 1);
    assert.equal(findWaveOf(payload, "XBOARD-002"), 1, "board-declared disjoint repo-X ticket joins wave 1");
    assert.equal(findWaveOf(payload, "XBOARD-003"), 2, "board-declared overlapping repo-X ticket moves later");
    const safe = payload.waves[0].tickets.find((t) => t.ticket === "XBOARD-001");
    assert.deepEqual(safe.files, ["coord/scripts/sample-module.js"]);
    assert.equal(safe.parallelizable, true);
  });
});

test("COORD-351: repo-X global-state and missing-file tickets still serialize", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "XSTATE-001", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "board", "Depends On": "" },
      { ID: "XSTATE-002", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "no files", "Depends On": "" },
      { ID: "XSTATE-003", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "product", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "XSTATE-001": ["coord/board/tasks.json"],
    "XSTATE-003": ["src/product.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    const stateWave = payload.waves.find((w) => w.tickets.some((t) => t.ticket === "XSTATE-001"));
    const noFilesWave = payload.waves.find((w) => w.tickets.some((t) => t.ticket === "XSTATE-002"));
    const state = stateWave.tickets.find((t) => t.ticket === "XSTATE-001");
    const noFiles = noFilesWave.tickets.find((t) => t.ticket === "XSTATE-002");
    assert.equal(stateWave.tickets.length, 1, "global-state repo-X ticket remains alone");
    assert.equal(noFilesWave.tickets.length, 1, "missing-file repo-X ticket remains alone");
    assert.equal(state.parallelizable, false);
    assert.equal(noFiles.parallelizable, false);
    assert.match(state.note, /global coordination state/);
    assert.match(noFiles.note, /no declared files/);
  });
});

test("COORD-030: a no-files ticket is flagged and scheduled alone, never silently parallelized", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "NOFILE-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "no declared files", "Depends On": "" },
      { ID: "HASFILE-002", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "has files", "Depends On": "" },
    ] }],
  };
  // NOFILE-001 has no prompt -> no declared files.
  const prompts = { "HASFILE-002": ["src/h.js"] };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    const nfWave = payload.waves.find((w) => w.tickets.some((t) => t.ticket === "NOFILE-001"));
    const nfEntry = nfWave.tickets.find((t) => t.ticket === "NOFILE-001");
    assert.equal(nfEntry.parallelizable, false);
    assert.match(nfEntry.note, /potentially-conflicting/);
    assert.equal(nfWave.tickets.length, 1, "a no-files ticket must not share a wave");
  });
});

test("COORD-030: an unsatisfiable dependency is excluded, never silently dropped; output is deterministic", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "ORPH-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "orphan", "Depends On": "GHOST-999" },
      { ID: "OK-002", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "ok", "Depends On": "" },
    ] }],
  };
  const prompts = { "ORPH-001": ["src/o.js"], "OK-002": ["src/k.js"] };
  withPlanWavesScenario(board, prompts, () => {
    const a = executeCommand(["plan-waves", "--json"]).stdout;
    const b = executeCommand(["plan-waves", "--json"]).stdout;
    assert.equal(a, b, "plan-waves must be deterministic for identical inputs");
    const payload = JSON.parse(a);
    const orphan = payload.excluded.find((e) => e.ticket === "ORPH-001");
    assert.ok(orphan, "the ticket with an unsatisfiable dep must be reported as excluded");
    assert.match(orphan.reason, /unsatisfiable dep/);
    assert.equal(findWaveOf(payload, "OK-002"), 1, "the schedulable ticket is still scheduled");
  });
});


test("COORD-801: excluded plan-wave tickets are deterministically sorted after deferred and unsatisfiable paths", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "AAA-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "deferred", "Depends On": "MID-001" },
      { ID: "MID-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "unknown dependency", "Depends On": "GHOST-999" },
      { ID: "ZZZ-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "unknown dependency", "Depends On": "GHOST-999" },
    ] }],
  };
  withPlanWavesScenario(board, {}, () => {
    const first = executeCommand(["plan-waves", "--json"]).stdout;
    const second = executeCommand(["plan-waves", "--json"]).stdout;
    assert.equal(second, first, "excluded ordering stays deterministic for identical input");
    const payload = JSON.parse(first);
    assert.equal(payload.wave_count, 0);
    assert.deepEqual(payload.excluded, [
      { ticket: "AAA-001", reason: "could not be scheduled (unsatisfied/cyclic dependency among remaining tickets)" },
      { ticket: "MID-001", reason: "unsatisfiable deps: GHOST-999" },
      { ticket: "ZZZ-001", reason: "unsatisfiable deps: GHOST-999" },
    ]);
  });
});

test("COORD-357: sequencer-plan groups overlapping active tickets and omits disjoint tickets", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "SEQ-001", Repo: "B", Pri: "P1", Status: "review", Owner: "u", Description: "a", "Depends On": "" },
      { ID: "SEQ-002", Repo: "B", Pri: "P2", Status: "doing", Owner: "u", Description: "b", "Depends On": "" },
      { ID: "SEQ-003", Repo: "B", Pri: "P2", Status: "review", Owner: "u", Description: "c", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "SEQ-001": ["src/shared.js"],
    "SEQ-002": ["src/shared.js"],
    "SEQ-003": ["src/other.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["sequencer-plan", "--json"]).value;
    assert.equal(payload.group_count, 1);
    assert.equal(payload.groups[0].gate_mode, "slice");
    assert.deepEqual(payload.groups[0].tickets.map((ticket) => ticket.ticket), ["SEQ-001", "SEQ-002"]);
    assert.ok(!JSON.stringify(payload).includes("SEQ-003"), "disjoint active ticket stays outside sequencer");
  });
});

test("COORD-357: sequencer-plan full-fallbacks missing and repo-X global-state surfaces", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "SEQ-MISS", Repo: "B", Pri: "P2", Status: "review", Owner: "u", Description: "missing", "Depends On": "" },
      { ID: "SEQ-XSTATE", Repo: "X", Pri: "P2", Status: "review", Owner: "u", Description: "board", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "SEQ-XSTATE": ["coord/board/tasks.json"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["sequencer-plan", "--json"]).value;
    assert.equal(payload.group_count, 2);
    const missing = payload.groups.find((group) => group.tickets.some((ticket) => ticket.ticket === "SEQ-MISS"));
    const globalState = payload.groups.find((group) => group.tickets.some((ticket) => ticket.ticket === "SEQ-XSTATE"));
    assert.equal(missing.gate_mode, "full");
    assert.equal(globalState.gate_mode, "full");
    assert.match(missing.tickets[0].reasons[0].code, /missing_declared_files/);
    assert.match(globalState.tickets[0].reasons[0].code, /repo_x_sequential_surface/);
  });
});

test("COORD-357: sequencer-plan uses active dependency edges for deterministic order", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "SDEP-001", Repo: "B", Pri: "P2", Status: "review", Owner: "u", Description: "dep", "Depends On": "" },
      { ID: "SDEP-002", Repo: "B", Pri: "P1", Status: "review", Owner: "u", Description: "child", "Depends On": "SDEP-001" },
    ] }],
  };
  const prompts = {
    "SDEP-001": ["src/a.js"],
    "SDEP-002": ["src/b.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["sequencer-plan", "--json"]).value;
    assert.equal(payload.group_count, 1);
    assert.deepEqual(payload.groups[0].tickets.map((ticket) => ticket.ticket), ["SDEP-001", "SDEP-002"]);
    assert.equal(payload.groups[0].gate_mode, "slice");
    assert.ok(payload.groups[0].tickets[1].reasons.some((reason) => reason.code === "dependency_edge"));
  });
});

test("COORD-388: merge-queue materializes sequencer groups with deterministic order and depth", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "MQ-001", Repo: "B", Pri: "P1", Status: "review", Owner: "alice", Description: "a", "Depends On": "" },
      { ID: "MQ-002", Repo: "B", Pri: "P2", Status: "review", Owner: "bob", Description: "b", "Depends On": "" },
      { ID: "MQ-003", Repo: "B", Pri: "P2", Status: "review", Owner: "cara", Description: "c", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "MQ-001": ["src/shared.js"],
    "MQ-002": ["src/shared.js"],
    "MQ-003": ["src/other.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["merge-queue", "--json"]).value;
    assert.equal(payload.mode, "contention_queue");
    assert.equal(payload.depth, 2);
    assert.equal(payload.group_count, 1);
    assert.equal(payload.groups[0].state, "queued");
    assert.deepEqual(payload.groups[0].tickets.map((ticket) => ticket.ticket), ["MQ-001", "MQ-002"]);
    assert.ok(!JSON.stringify(payload).includes("MQ-003"), "disjoint ticket stays on the normal land path");
  });
});

test("COORD-388: merge-queue records inspectable runtime state only with --record", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "MQREC-001", Repo: "X", Pri: "P2", Status: "review", Owner: "alice", Description: "state", "Depends On": "" },
    ] }],
  };
  const prompts = { "MQREC-001": ["coord/board/tasks.json"] };
  const statePath = path.join(state.RUNTIME_DIR, "merge-queue.json");
  try { fs.rmSync(statePath, { force: true }); } catch { /* best effort */ }
  withPlanWavesScenario(board, prompts, () => {
    const dry = executeCommand(["merge-queue", "--json"]).value;
    assert.equal(dry.depth, 1);
    assert.equal(fs.existsSync(statePath), false, "read-only inspect must not write queue state");
    const recorded = executeCommand(["merge-queue", "--record", "--json"]).value;
    assert.equal(recorded.depth, 1);
    assert.equal(fs.existsSync(statePath), true, "--record writes queue state");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.groups[0].tickets[0].ticket, "MQREC-001");
  });
});

test("COORD-388: merge-queue blocks ambiguous dependency cycles instead of picking an order", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "MQCYC-001", Repo: "B", Pri: "P1", Status: "review", Owner: "alice", Description: "a", "Depends On": "MQCYC-002" },
      { ID: "MQCYC-002", Repo: "B", Pri: "P1", Status: "review", Owner: "bob", Description: "b", "Depends On": "MQCYC-001" },
    ] }],
  };
  const prompts = {
    "MQCYC-001": ["src/a.js"],
    "MQCYC-002": ["src/b.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["merge-queue", "--json"]).value;
    assert.equal(payload.blocked_group_count, 1);
    assert.equal(payload.groups[0].state, "blocked");
    assert.equal(payload.groups[0].ambiguous_ordering, true);
    assert.equal(payload.groups[0].ambiguities[0].code, "ambiguous_dependency_cycle");
  });
});

// ---------------------------------------------------------------------------
// COORD-031: gov dispatch-plan (TOKEN_ECONOMICS.md — wires levers #2/#3/#4/#5).
// ---------------------------------------------------------------------------

function withDispatchPlanScenario(board, prompts, probesByTicket, fn) {
  // prompts: { ID: [files] }; probesByTicket: { ID: [probe,...] }.
  // COORD-290: seed prompts + precheck sidecars into a sandbox PROMPTS_DIR.
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "dispatchplan-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  const promptsDir = path.join(tempBoard, "prompts");
  const ticketsDir = path.join(promptsDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  for (const [ticketId, files] of Object.entries(prompts || {})) {
    const lines = [`# ${ticketId}: sample`, "", "## Likely Files"];
    for (const f of files) {
      lines.push(`- \`${f}\` (a file)`);
    }
    fs.writeFileSync(path.join(ticketsDir, `${ticketId}.md`), lines.join("\n"), "utf8");
  }
  for (const [ticketId, probes] of Object.entries(probesByTicket || {})) {
    fs.writeFileSync(path.join(ticketsDir, `${ticketId}.precheck.json`), JSON.stringify({ probes }, null, 2), "utf8");
  }
  return withScopedGovernanceTestContext({ BOARD_PATH: boardPath, PROMPTS_DIR: promptsDir }, () => {
    return fn({
      boardPath,
      promptsDir,
      runtimeDir: state.RUNTIME_DIR,
      eventLogPath: state.GOVERNANCE_EVENT_LOG_PATH,
    });
  });
}

function dispatchFindTicket(payload, ticket) {
  for (const w of payload.waves) {
    const t = w.tickets.find((x) => x.ticket === ticket);
    if (t) {
      return { wave: w.wave, entry: t };
    }
  }
  return null;
}

function withTierPolicyOverride(policy, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-context-policy-"));
  const policyPath = path.join(tempDir, "tier-policy.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  try {
    return withScopedGovernanceTestContext({ TIER_POLICY_PATH_OVERRIDE: policyPath }, fn);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("COORD-770: dispatch manifest preserves mode and legacy tier policies default open", () => {
  const board = { metadata: { title: "B" }, sections: [{ rows: [
    { ID: "DPC-770", Repo: "B", Pri: "P3", Status: "todo", Owner: "u", Description: "context mode", "Depends On": "" },
  ] }] };
  const prompts = { "DPC-770": ["src/dpc.js"] };
  const canonicalPolicy = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "product", "tier-policy.json"), "utf8"));
  const packOnly = structuredClone(canonicalPolicy);
  packOnly.tiers.mechanical.context_mode = "pack_only";
  withTierPolicyOverride(packOnly, () => withDispatchPlanScenario(board, prompts, {}, () => {
    const payload = executeCommand(["dispatch-plan", "--json"]).value;
    assert.equal(dispatchFindTicket(payload, "DPC-770").entry.context_mode, "pack_only");
  }));

  const legacyPolicy = structuredClone(canonicalPolicy);
  for (const tier of Object.values(legacyPolicy.tiers)) delete tier.context_mode;
  withTierPolicyOverride(legacyPolicy, () => withDispatchPlanScenario(board, prompts, {}, () => {
    const payload = executeCommand(["dispatch-plan", "--json"]).value;
    assert.equal(dispatchFindTicket(payload, "DPC-770").entry.context_mode, "open");
  }));

  const invalidPolicy = structuredClone(canonicalPolicy);
  invalidPolicy.tiers.mechanical.context_mode = "unrestricted";
  withTierPolicyOverride(invalidPolicy, () => withDispatchPlanScenario(board, prompts, {}, () => {
    const refused = executeCommand(["dispatch-plan", "--json"]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /context_mode must be one of open\|pack_only/);
  }));
});

test("COORD-770: dispatch action rejects a ticket that is absent from the current board", () => {
  const board = { metadata: { title: "B" }, sections: [{ rows: [] }] };
  const missingTicketAction = createTokenEconomics({
    fail: (message) => { throw new Error(message); },
    readBoard: () => board,
    getTicketRef: () => null,
  });
  assert.throws(
    () => missingTicketAction.dispatchActionForTicket("DPC-MISSING"),
    /Unknown ticket "DPC-MISSING"/,
  );
});

test("COORD-770: dispatch keeps malformed and disabled command probes visible as unknown spawns", () => {
  const board = { metadata: { title: "B" }, sections: [{ rows: [
    { ID: "DPU-MALFORMED", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "bad sidecar", "Depends On": "" },
    { ID: "DPU-COMMAND", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "disabled command", "Depends On": "" },
  ] }] };
  const prompts = { "DPU-MALFORMED": ["src/malformed.js"], "DPU-COMMAND": ["src/command.js"] };
  const probes = { "DPU-COMMAND": [{ type: "test", command: "true", expect: "pass" }] };
  withDispatchPlanScenario(board, prompts, probes, ({ promptsDir }) => {
    const malformedPath = path.join(promptsDir, "tickets", "DPU-MALFORMED.precheck.json");
    fs.writeFileSync(malformedPath, "{ invalid json", "utf8");
    const payload = executeCommand(["dispatch-plan", "--json"]).value;
    const malformed = dispatchFindTicket(payload, "DPU-MALFORMED").entry;
    assert.equal(malformed.precheck.verdict, "unknown");
    assert.match(malformed.precheck.parse_error, /JSON|position|property/i);
    assert.match(malformed.reason, /unparseable precheck probes/);
    assert.equal(malformed.action, "spawn");

    const command = dispatchFindTicket(payload, "DPU-COMMAND").entry;
    assert.equal(command.precheck.verdict, "unknown");
    assert.equal(command.precheck.probe_count, 1);
    assert.equal(command.precheck.parse_error, null);
    assert.match(command.reason, /verdict unknown -> spawn/);
    assert.equal(command.action, "spawn", "dispatch must not run or treat an opt-in command probe as satisfied");
  });
});

test("COORD-031: dispatch-plan composes waves + per-ticket precheck->action + tier + context-pack; satisfied=skip, unsatisfied=spawn", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DP-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "satisfied", "Depends On": "" },
      { ID: "DP-002", Repo: "B", Pri: "P0", Status: "todo", Owner: "u", Description: "unsatisfied critical", "Depends On": "" },
    ] }],
  };
  const prompts = { "DP-001": ["src/dp1.js"], "DP-002": ["src/dp2.js"] };
  // DP-001 has a probe that PASSES (this very test file exists) -> already-satisfied -> skip.
  // DP-002 has a probe that FAILS (missing file) -> not-started -> spawn.
  const probes = {
    "DP-001": [{ type: "file-exists", path: "coord/engine/scripts/governance.test.js", expect: "present" }],
    "DP-002": [{ type: "file-exists", path: "coord/scripts/does-not-exist-zzz.js", expect: "present" }],
  };
  withDispatchPlanScenario(board, prompts, probes, () => {
    const payload = executeCommand(["dispatch-plan", "--json"]).value;
    const dp1 = dispatchFindTicket(payload, "DP-001");
    const dp2 = dispatchFindTicket(payload, "DP-002");
    assert.ok(dp1 && dp2, "both tickets scheduled");

    // SKIP entry: action + reason + governed finalize-already-satisfied command.
    assert.equal(dp1.entry.action, "skip");
    assert.equal(dp1.entry.precheck.verdict, "already-satisfied");
    assert.match(dp1.entry.finalize_command, /gov finalize DP-001 --no-pr --already-landed/);

    // SPAWN entry: action + tier-routed model class + context-pack present.
    assert.equal(dp2.entry.action, "spawn");
    assert.equal(dp2.entry.precheck.verdict, "not-started");
    assert.equal(dp2.entry.tier, "critical", "P0 derives the critical tier");
    assert.equal(dp2.entry.suggested_model_class, "frontier");
    assert.ok(dp2.entry.context_pack && dp2.entry.context_pack.stable && dp2.entry.context_pack.ticket_specific,
      "spawn entry carries the context-pack with the stable/ticket-specific split");
    assert.ok(Array.isArray(dp2.entry.context_pack.stable.shared_references) && dp2.entry.context_pack.stable.shared_references.length > 0);

    // Manifest carries the stable cache-prefix marker.
    assert.equal(payload.cache_prefix.id, "coord-dispatch-stable-v1");
    assert.ok(payload.cache_prefix.shared_references.length > 0);
  });
});

test("COORD-771: dispatch manifest hashes the exact shared prefix bytes for every ticket in a wave", () => {
  const board = { metadata: { title: "B" }, sections: [{ rows: [
    { ID: "DP771-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "one", "Depends On": "" },
    { ID: "DP771-002", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "two", "Depends On": "" },
  ] }] };
  const prompts = { "DP771-001": ["src/one.js"], "DP771-002": ["src/two.js"] };
  withDispatchPlanScenario(board, prompts, {}, () => {
    const payload = executeCommand(["dispatch-plan", "--json"]).value;
    const first = dispatchFindTicket(payload, "DP771-001");
    const second = dispatchFindTicket(payload, "DP771-002");
    assert.equal(first.wave, second.wave, "fixture tickets must share one wave");
    assert.deepEqual(first.entry.context_pack.stable, second.entry.context_pack.stable);
    assert.notDeepEqual(first.entry.context_pack.ticket_specific, second.entry.context_pack.ticket_specific);
    assert.match(payload.cache_prefix.sha256, /^[a-f0-9]{64}$/);
    const contextMarkdown = executeCommand(["context-pack", "DP771-001", "--md"]).stdout;
    const marker = "<!-- TICKET-SPECIFIC: varies per ticket -->";
    const shippedPrefix = contextMarkdown.slice(0, contextMarkdown.indexOf(marker));
    assert.equal(shippedPrefix, renderDispatchCachePrefix(payload.cache_prefix),
      "context-pack must ship the byte-identical resolved stable prefix that dispatch hashed");
    const prefixBytes = Buffer.from(shippedPrefix, "utf8");
    assert.equal(payload.cache_prefix.sha256, crypto.createHash("sha256").update(prefixBytes).digest("hex"));
    assert.ok(payload.cache_prefix.resolved_references.every((reference) => reference.content.length > 0),
      "the hash must bind actual resolved stable files, not just their paths");
  });
});

test("COORD-771: gov reports a used-prefix hash mismatch as an observation", () => {
  withCostLedgerEnv("prefix-use-report-", COST_BOARD, ({ eventLogPath }) => {
    const expected = "a".repeat(64);
    const used = "b".repeat(64);
    const result = executeCommand([
      "report-prefix-use", "C-001",
      "--expected-prefix-hash", expected,
      "--used-prefix-hash", used,
    ]);
    assert.equal(result.ok, true, result.error || result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "mismatch");
    assert.equal(payload.observation_only, true);
    const journal = fs.readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const report = journal.find((event) => event.details?.event_type === "dispatch.prefix_used");
    assert.ok(report, "prefix-use mismatch must be visible in the governance journal");
    assert.deepEqual(report.details.prefix_use, {
      expected_prefix_hash: expected,
      used_prefix_hash: used,
      status: "mismatch",
      observation_only: true,
    });
  });
});

test("COORD-769: dispatch entries carry deterministic context budgets and measured pack size", () => {
  const payload = executeCommand(["dispatch-plan", "--json"]).value;
  const entries = payload.waves.flatMap((wave) => wave.tickets);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(Number.isInteger(entry.context_budget.max_bytes));
    assert.ok(entry.context_budget.max_bytes > 0);
    assert.ok(Number.isInteger(entry.context_budget.measured_bytes));
    assert.equal(entry.context_budget.decision, "accepted");
    assert.ok(entry.context_budget.measured_bytes <= entry.context_budget.max_bytes);
  }
});

test("COORD-031: unknown verdict (no probes / unparseable) NEVER yields a false skip — always spawn", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DPU-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "no probes", "Depends On": "" },
    ] }],
  };
  withDispatchPlanScenario(board, { "DPU-001": ["src/u.js"] }, {}, () => {
    const payload = executeCommand(["dispatch-plan", "--json"]).value;
    const e = dispatchFindTicket(payload, "DPU-001").entry;
    assert.equal(e.precheck.verdict, "unknown");
    assert.equal(e.action, "spawn", "unknown verdict must spawn, never skip");
    assert.match(e.reason, /never a false skip/);
    assert.ok(!("finalize_command" in e), "a spawn entry must NOT carry a finalize-already-satisfied command");
  });
});

test("COORD-031: dispatch-plan is deterministic + hash-stable across two runs (no timestamps/random)", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DPH-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "a", "Depends On": "" },
      { ID: "DPH-002", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "coord", "Depends On": "" },
      { ID: "DPH-003", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "dep", "Depends On": "DPH-001" },
    ] }],
  };
  const prompts = { "DPH-001": ["src/a.js"], "DPH-002": ["coord/scripts/governance.js"], "DPH-003": ["src/c.js"] };
  withDispatchPlanScenario(board, prompts, {}, () => {
    const a = executeCommand(["dispatch-plan", "--json"]).stdout;
    const b = executeCommand(["dispatch-plan", "--json"]).stdout;
    assert.equal(a, b, "identical board state must produce a byte-identical manifest");
    const payload = JSON.parse(a);
    // Safe declared repo-X code/doc surfaces may parallelize (inherited from plan-waves).
    const x = dispatchFindTicket(payload, "DPH-002");
    assert.equal(x.entry.parallelizable, true);
    assert.match(x.entry.wave_note, /safe declared coord code\/doc surfaces/);
    // dependency ordering preserved: DPH-003 after DPH-001.
    const lead = dispatchFindTicket(payload, "DPH-001");
    const follower = dispatchFindTicket(payload, "DPH-003");
    assert.ok(follower.wave > lead.wave, "the dependent is scheduled in a later wave");
  });
});

test("COORD-031: --md emits a context-pack pointer (not the inlined pack) and the cache prefix", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DPM-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "md", "Depends On": "" },
    ] }],
  };
  withDispatchPlanScenario(board, { "DPM-001": ["src/m.js"] }, {}, () => {
    const out = executeCommand(["dispatch-plan", "--md"]).stdout;
    assert.match(out, /Cache prefix: `coord-dispatch-stable-v1`/);
    assert.match(out, /Prefix SHA-256: `[a-f0-9]{64}` \(\d+ bytes\)/);
    assert.match(out, /context-pack DPM-001 --md/, "--md references the context-pack by pointer");
    assert.equal(executeCommand(["dispatch-plan", "--md"]).stdout, out, "--md is deterministic");
  });
});

test("COORD-770: markdown dispatch renders selected wave, both execution lanes, skip follow-up, and excluded work", () => {
  const board = { metadata: { title: "B" }, sections: [{ rows: [
    { ID: "DPM-SELECTED", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "satisfied", "Depends On": "" },
    { ID: "DPM-SEQUENTIAL", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "no declared files", "Depends On": "" },
    { ID: "DPM-EXCLUDED", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "unknown dependency", "Depends On": "DPX-999" },
  ] }] };
  const prompts = { "DPM-SELECTED": ["src/selected.js"], "DPM-EXCLUDED": ["src/excluded.js"] };
  const probes = { "DPM-SELECTED": [{ type: "file-exists", path: "coord/engine/scripts/token-economics.test.js", expect: "present" }] };
  withDispatchPlanScenario(board, prompts, probes, () => {
    const selected = executeCommand(["dispatch-plan", "--repo", "B", "--wave", "1", "--md"]);
    assert.equal(selected.ok, true, selected.error);
    assert.match(selected.stdout, /Dispatch plan \(status=todo, repo=B, wave=1\)/);
    assert.match(selected.stdout, /DPM-SELECTED - SKIP \(parallel\)/);
    assert.match(selected.stdout, /- finalize: `coord\/scripts\/gov finalize DPM-SELECTED --no-pr --already-landed/);
    assert.match(selected.stdout, /## Excluded \(no silent drops\)/);
    assert.match(selected.stdout, /DPM-EXCLUDED: unsatisfiable deps: DPX-999/);

    const complete = executeCommand(["dispatch-plan", "--repo", "B", "--md"]);
    assert.equal(complete.ok, true, complete.error);
    assert.match(complete.stdout, /DPM-SEQUENTIAL - SPAWN \(sequential\)/,
      "a no-file ticket remains visible in its isolated sequential wave");
  });
});

test("COORD-772: dispatch-plan validates positive waves and preserves optional execution identity", () => {
  const board = { metadata: { title: "B" }, sections: [{ rows: [
    { ID: "DPI-772", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "execution identity", "Depends On": "" },
  ] }] };
  withDispatchPlanScenario(board, { "DPI-772": ["src/handler.js"] }, {}, ({ eventLogPath }) => {
    const beforeEvents = fs.existsSync(eventLogPath) ? fs.readFileSync(eventLogPath, "utf8") : null;

    const invalidWave = executeCommand(["dispatch-plan", "--json", "--wave", "0"]);
    assert.equal(invalidWave.ok, false);
    assert.match(invalidWave.error, /--wave must be a positive integer/);

    const identified = executeCommand([
      "dispatch-plan", "--json", "--execution-id", "stable-dispatch-772",
    ]);
    assert.equal(identified.ok, true, identified.error);
    assert.equal(JSON.parse(identified.stdout).dispatch_execution_id, "stable-dispatch-772");

    const unsafeIdentity = executeCommand([
      "dispatch-plan", "--json", "--execution-id", "unsafe id",
    ]);
    assert.equal(unsafeIdentity.ok, false);
    assert.match(unsafeIdentity.error, /--execution-id must be 1-128 safe identifier characters/);

    const afterEvents = fs.existsSync(eventLogPath) ? fs.readFileSync(eventLogPath, "utf8") : null;
    assert.equal(afterEvents, beforeEvents, "read-only dispatch-plan errors must not append cost observations");
  });
});

test("COORD-031: dispatch-plan is read-only — no board/lifecycle mutation", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DPR-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "ro", "Depends On": "" },
    ] }],
  };
  withDispatchPlanScenario(board, { "DPR-001": ["src/r.js"] }, {}, ({ boardPath }) => {
    const before = fs.readFileSync(boardPath, "utf8");
    executeCommand(["dispatch-plan", "--json"]);
    const after = fs.readFileSync(boardPath, "utf8");
    assert.equal(before, after, "dispatch-plan must not mutate the board");
  });
});
