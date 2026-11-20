"use strict";
process.env.COORD_PROJECT_CONFIG = require("node:path").resolve(__dirname, "fixtures", "hermetic-project.config.js"); // COORD-967: hermetic board/integration branch defaults

// COORD-645-F3 — REAL end-to-end governed lifecycle with the candidate write
// barrier active.
//
// The test this replaces built an array of {tool_name, tool_input} objects
// containing command strings and asserted the hook returned 0 for each. Nothing
// ran. It proved command classification and was named as if it proved a
// lifecycle — the exact evidence-overstatement failure this ticket exists to
// fix.
//
// This test installs a real engine into an isolated temp workspace and drives
// the ACTUAL governance CLI through todo -> doing -> commit -> review -> done.
// Every shell command and every file write is first submitted to the real
// wired hook (`runtime-authority-hook.js`) exactly as the harness would submit
// it; if the hook refuses, the step does not run and the test fails. Assertions
// are on the STATE the lifecycle produced — board transitions, lock creation
// and release, the git commit and its contents, PR and landing evidence,
// worktree cleanup — not on the hook's exit code.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withApprovedPacket } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/approved-reconcile.js"));
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");

const ENGINE_COORD = path.resolve(__dirname, "..", "..");
const HOOK = path.join(__dirname, "runtime-authority-hook.js");

// COORD-930: the barrier's canonical coord dir is its own install location. A fixture's
// coord dir gets a copy of the entry hook under its engine/scripts (every other engine
// module is a symlink to the real file), so no environment variable can redirect it.
function installedHook(coordDir) {
  const target = path.join(coordDir, "engine", "scripts", "runtime-authority-hook.js");
  if (fs.existsSync(target)) return target;
  const scripts = path.dirname(target);
  fs.mkdirSync(scripts, { recursive: true });
  for (const entry of fs.readdirSync(__dirname)) {
    if (entry !== "runtime-authority-hook.js") fs.symlinkSync(path.join(__dirname, entry), path.join(scripts, entry));
  }
  fs.copyFileSync(HOOK, target);
  const paths = path.join(coordDir, "paths.js");
  if (!fs.existsSync(paths)) fs.symlinkSync(path.join(__dirname, "..", "..", "paths.js"), paths);
  return target;
}

const TICKET = "FIX-1";

const GIT = ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture"];

const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");

function git(cwd, args) {
  const res = gitFixtureSpawn(cwd, [...GIT, ...args]);
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

// A real engine in a temp workspace. Tests and runtime state are excluded: the
// engine does not require them, and copying them would triple the fixture.
function installFixtureEngine(root) {
  const target = path.join(root, "coord");
  require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/coord-engine-schemas.js")).installCanonicalEngine(target, ENGINE_COORD);
  fs.mkdirSync(path.join(target, "board", "plans"), { recursive: true });
  fs.mkdirSync(path.join(target, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(target, ".runtime", "locks"), { recursive: true });
  // COORD-867: the gate modules live under coord/engine/scripts; the coord/scripts shims need the engine tree beside them.
  for (const dir of ["scripts", "engine", "product", "docs"]) {
    const from = path.join(ENGINE_COORD, dir);
    fs.cpSync(from, path.join(target, dir), {
      recursive: true,
      // The filter must be RELATIVE to the source root: the engine itself may
      // live inside a `.worktrees/` path, and an absolute-path exclusion would
      // silently copy nothing.
      filter: (src) => {
        const rel = path.relative(from, src);
        return !/\.test\.js$/.test(rel) && !/(?:^|[\\/])(?:\.runtime|\.worktrees|node_modules)(?:[\\/]|$)/.test(rel);
      },
    });
  }
  fs.cpSync(path.join(ENGINE_COORD, "board", "board.js"), path.join(target, "board", "board.js"));
  for (const entry of fs.readdirSync(path.join(ENGINE_COORD, "board"))) {
    if (entry.endsWith(".schema.json")) {
      fs.cpSync(path.join(ENGINE_COORD, "board", entry), path.join(target, "board", entry));
    }
  }
  for (const file of ["paths.js", "engine-pin.json", "GOVERNANCE.md", "AGENTS.md", "TEMPLATE_SYNC_MANIFEST.json"]) {
    fs.cpSync(path.join(ENGINE_COORD, file), path.join(target, file));
  }
  // COORD-967: the sandbox config is the hermetic fixture, never a copy of the live config file.
  fs.cpSync(path.join(__dirname, "fixtures", "hermetic-project.config.js"), path.join(target, "project.config.js"));
  return target;
}

function seedBoard(coordDir, description = "Fixture lifecycle ticket.") {
  const board = {
    version: 1,
    metadata: {
      title: "COORD-645 Lifecycle Fixture Board",
      last_updated: new Date().toISOString(),
      canonical_references: ["coord/GOVERNANCE.md"],
      plan_markdown_render_statuses: ["doing", "review"],
      preamble: [],
    },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "Fixture",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: TICKET,
            Repo: "X",
            Type: "bug",
            Pri: "P1",
            Status: "todo",
            Owner: "unassigned",
            Description: description,
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: { [TICKET]: `coord/prompts/tickets/${TICKET}.md` },
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
    waiver_index: {},
  };
  fs.writeFileSync(path.join(coordDir, "board", "tasks.json"), `${JSON.stringify(board, null, 2)}\n`);
  // COORD-813: FIX-1's prompt is ticket-specific (its own default file), so
  // start requires a "## Acceptance" heading with real criteria. Author one
  // rather than waiving: these tests exercise the lifecycle, not prompts.
  fs.writeFileSync(
    path.join(coordDir, "prompts", "tickets", `${TICKET}.md`),
    `# ${TICKET}\n\n## Assignment\nFixture.\n\n## Acceptance\n` +
      `- ${TICKET} moves through the governed lifecycle exactly as each fixture test asserts.\n`
  );
  fs.writeFileSync(path.join(coordDir, "PLAN.md"), "");
  fs.writeFileSync(path.join(coordDir, "QUESTIONS.md"), "# Questions\n");
}

function renderFixtureViews(ws) {
  require(path.join(ws.coordDir, "board/board.js")).renderBoardArtifacts();
}

function makeWorkspace(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-645-lifecycle-")));
  const coordDir = installFixtureEngine(root);
  seedBoard(coordDir, options.description);
  renderFixtureViews({ coordDir });
  const config = require(path.join(coordDir, "project.config.js"));
  for (const [repo, code] of [["backend", "B"], ["frontend", "F"]]) {
    const dir = path.join(root, repo);
    fs.mkdirSync(dir, { recursive: true });
    gitFixture(dir, ["init", "-q", "-b", config.repos[code].integrationBranch, "."]);
    fs.writeFileSync(path.join(dir, "README.md"), `${repo}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "seed"]);
  }
  gitFixture(root, ["init", "-q", "-b", "main", "."]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed"]);
  // COORD-977: the control-plane integration branch must exist for the reuse gate's
  // shared base resolver (fail-closed when neither origin/dev nor local dev resolves).
  git(root, ["branch", "dev", "main"]);
  return { root, coordDir };
}

// --------------------------------------------------------------------------
// The harness stand-in: submit to the real hook FIRST, and only run the step
// if the hook permits it. This is what "with the candidate hook active" means
// outside the Claude Code process.
// --------------------------------------------------------------------------

const hookCalls = [];

function askHook(ws, payload) {
  const res = spawnSync(process.execPath, [installedHook(ws.coordDir)], {
    cwd: ws.root,
    encoding: "utf8",
    env: {
      ...process.env,
      COORD_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_SESSION_ID: "",
      COORD_PROVIDER: "",
      COORD_INSTANCE_ID: "",
      TOOL_INPUT: "",
    },
    input: JSON.stringify(payload),
  });
  hookCalls.push({ payload, status: res.status, stderr: res.stderr });
  return res;
}

function guardedRun(ws, command, extraEnv = {}) {
  const gate = askHook(ws, { tool_name: "Bash", tool_input: { command } });
  assert.equal(gate.status, 0, `barrier BLOCKED a lifecycle command: ${command}\n${gate.stderr}`);
  const res = spawnSync("bash", ["-c", command], {
    cwd: ws.root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, COORD_SESSION_ID: "coord645-fixture" },
  });
  assert.equal(res.status, 0, `lifecycle command failed: ${command}\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

function refusedGov(ws, args, extraEnv = {}) {
  const command = `node ${JSON.stringify(path.join(ws.coordDir, "scripts", "governance.js"))} ${args}`;
  const gate = askHook(ws, { tool_name: "Bash", tool_input: { command } });
  assert.equal(gate.status, 0, `barrier BLOCKED a governed refusal probe: ${command}\n${gate.stderr}`);
  const res = spawnSync("bash", ["-c", command], {
    cwd: ws.root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, COORD_SESSION_ID: "coord645-fixture" },
  });
  assert.equal(res.status, 1, `expected governed refusal (exit 1): ${command}\nexit=${res.status}\n${res.stdout}\n${res.stderr}`);
  return `${res.stdout || ""}\n${res.stderr || ""}`;
}

function guardedWrite(ws, file, content) {
  const gate = askHook(ws, { tool_name: "Write", tool_input: { file_path: file, content } });
  assert.equal(gate.status, 0, `barrier BLOCKED a legitimate worktree write: ${file}\n${gate.stderr}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function refusedWrite(ws, file, content) {
  const gate = askHook(ws, { tool_name: "Write", tool_input: { file_path: file, content } });
  assert.equal(gate.status, 2, `expected the barrier to REFUSE ${file}`);
  return gate.stderr;
}

function gov(ws, args, extraEnv = {}) {
  const entry = path.join(ws.coordDir, "scripts", "governance.js");
  const run = (command) => guardedRun(ws, `node ${JSON.stringify(entry)} ${command}`, extraEnv);
  if (!/^reconcile\b/.test(args)) return run(args);

  const argv = [...args.matchAll(/("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g)].map(([token]) => {
    if (token.startsWith('"')) return JSON.parse(token);
    if (token.startsWith("'")) return token.slice(1, -1);
    return token;
  });
  const shellArgs = (commandArgs) => commandArgs.map((arg) => `'${String(arg).replace(/'/g, "'\\''")}'`).join(" ");
  const rawCli = (commandArgs) => {
    const command = `node ${JSON.stringify(entry)} ${shellArgs(commandArgs)}`;
    const dryGate = askHook(ws, { tool_name: "Bash", tool_input: { command } });
    assert.equal(dryGate.status, 0, `barrier BLOCKED fixture packet inspection: ${command}\n${dryGate.stderr}`);
    return spawnSync(process.execPath, [entry, ...commandArgs], {
      cwd: ws.root, encoding: "utf8",
      env: { ...process.env, ...extraEnv, COORD_SESSION_ID: "coord645-fixture" },
    });
  };
  const approvedArgs = withApprovedPacket(argv, rawCli);
  const hookCommand = `node ${JSON.stringify(entry)} ${shellArgs(approvedArgs)}`;
  const gate = askHook(ws, { tool_name: "Bash", tool_input: { command: hookCommand } });
  assert.equal(gate.status, 0, `barrier BLOCKED a signed fixture reconciliation: ${hookCommand}\n${gate.stderr}`);

  const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
  try {
    const runApproved = () => approval.runCli(ws.coordDir, approvedArgs, {
      cwd: ws.root, encoding: "utf8",
      env: { ...process.env, ...extraEnv, COORD_SESSION_ID: "coord645-fixture" },
    });
    const first = runApproved();
    const refusal = `${first.stdout || ""}\n${first.stderr || ""}`;
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(refusal);
    assert.notEqual(first.status, 0, "fixture reconciliation must require a signed approval");
    assert.ok(digest, refusal);
    assert.match(refusal, /requires a signed human-admin approval/);
    approval.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: digest[1] });
    const accepted = runApproved();
    assert.equal(accepted.status, 0,
      `${hookCommand}\ninitial refusal:\n${refusal}\nretry:\n${accepted.stdout}\n${accepted.stderr}`);
    return accepted.stdout;
  } finally { approval.cleanup(); }
}

function reconcileFixture(ws, args) {
  // The tests intentionally seed/change canonical state outside the CLI. Render
  // those disposable fixture bytes before the explicit fixture reconciliation.
  renderFixtureViews(ws);
  return gov(ws, args);
}

test("COORD-1048: signed reconcile retry is stable while board and plan packet tampering refuses", { timeout: 120000 }, () => {
  const ws = makeWorkspace();
  const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
  try {
    const planRecord = path.join(ws.coordDir, ".runtime", "plans", `${TICKET}.json`);
    fs.mkdirSync(path.dirname(planRecord), { recursive: true });
    const planRecords = require("./plan-records.js")({ buildDefaultGovernancePlan: () => ({
      expected_closeout: { method: "no_pr", base_ref: "main", provenance_note: null },
      review_profile: "standard", ticket_local_repairs: [],
    }) });
    const planRecordValue = planRecords.legacyPlanRecordDefaults(TICKET);
    planRecordValue.change_summary = ["approved bytes"];
    const planBytes = () => Buffer.from(`${JSON.stringify(planRecordValue, null, 2)}\n`);
    fs.writeFileSync(planRecord, planBytes());
    renderFixtureViews(ws);

    const entry = path.join(ws.coordDir, "scripts", "governance.js");
    const env = { ...process.env, COORD_SESSION_ID: "coord1048-reconcile-fixture" };
    const rawCli = (args) => spawnSync(process.execPath, [entry, ...args], { cwd: ws.root, env, encoding: "utf8" });
    const args = ["reconcile", "--reason", "approve exact fixture genesis", "--human-admin-override", "fixture admin approves exact genesis"];
    const approvedArgs = withApprovedPacket(args, rawCli);
    const packetPath = approvedArgs[approvedArgs.indexOf("--expect-paths-file") + 1];
    const packetText = fs.readFileSync(packetPath, "utf8");
    assert.match(packetText, /board\/tasks\.json/);
    assert.match(packetText, /\.runtime\/plans\/FIX-1\.json/, "the durable runtime plan record is in the approved packet");

    const runApproved = () => approval.runCli(ws.coordDir, approvedArgs, { cwd: ws.root, env, encoding: "utf8" });
    const first = runApproved();
    const firstText = `${first.stdout || ""}\n${first.stderr || ""}`;
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(firstText);
    assert.notEqual(first.status, 0);
    assert.match(firstText, /requires a signed human-admin approval/);
    assert.ok(digest, firstText);
    approval.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: digest[1] });

    const eventsPath = path.join(ws.coordDir, ".runtime", "governance-events.ndjson");
    const readEvents = () => fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
    const refusesTamperedBytes = (file, mutate) => {
      const before = fs.readFileSync(file);
      const value = JSON.parse(before.toString("utf8"));
      mutate(value);
      const tampered = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      fs.writeFileSync(file, tampered);
      const refused = runApproved();
      const text = `${refused.stdout || ""}\n${refused.stderr || ""}`;
      assert.notEqual(refused.status, 0, "a signed approval must not authorize changed packet bytes");
      assert.match(text, /drift does not match the approved packet/, text);
      assert.deepEqual(fs.readFileSync(file), tampered, "the failed retry leaves tampered bytes untouched");
      assert.equal(readEvents().some((event) => event.command === "manual-reconcile"), false,
        "a tampered packet never records a reconcile mutation");
      fs.writeFileSync(file, before);
    };
    refusesTamperedBytes(path.join(ws.coordDir, "board", "tasks.json"), (board) => {
      board.metadata.title = "Tampered fixture board bytes";
    });
    refusesTamperedBytes(planRecord, (record) => {
      record.change_summary = ["tampered plan bytes"];
    });

    const accepted = runApproved();
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    const mutation = readEvents().findLast((event) => event.command === "manual-reconcile");
    assert.ok(mutation, "the restored approved packet completes its reconcile mutation");
    assert.ok(mutation.details.approval_record);
    assert.ok(mutation.details.human_admin_session);
    assert.deepEqual(fs.readFileSync(planRecord), planBytes());
  } finally {
    approval.cleanup();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

function boardRow(ws) {
  const board = JSON.parse(fs.readFileSync(path.join(ws.coordDir, "board", "tasks.json"), "utf8"));
  for (const section of board.sections) {
    for (const row of section.rows || []) if (row.ID === TICKET) return { row, board };
  }
  throw new Error(`${TICKET} not on the board`);
}

function lockPath(ws) {
  return path.join(ws.coordDir, ".runtime", "locks", `${TICKET}.lock`);
}

test("COORD-748: collection setters preserve prior evidence unless replacement is explicit", { timeout: 180000 }, () => {
  const ws = makeWorkspace();
  try {
    reconcileFixture(ws, `reconcile --reason ${JSON.stringify("fixture genesis baseline")} --human-admin-override ${JSON.stringify("Fixture administrator authorizes this seeded genesis state")}`);
    const assigned = JSON.parse(gov(ws, "agentid --assign"));
    assert.ok(assigned.handle);
    gov(ws, `start ${TICKET}`);

    const planPath = path.join(ws.coordDir, ".runtime", "plans", `${TICKET}.json`);
    const journalPath = path.join(ws.coordDir, ".runtime", "governance-events.ndjson");
    const boardPath = path.join(ws.coordDir, "board", "tasks.json");
    const statePaths = [boardPath, path.join(ws.coordDir, "PLAN.md"), planPath, journalPath];
    const snapshot = () => statePaths.map((file) => fs.readFileSync(file));
    const cycleOne = "lens=contract; diff=public fixture; risks=lost evidence, stale denominator; findings=none; verification=fixture; verdict=pass";
    const cycleTwo = "lens=auth; diff=public fixture; risks=wrong owner, silent overwrite; findings=none; verification=fixture; verdict=pass";
    const cycleThree = "lens=operability; diff=public fixture; risks=stale output, missed refusal; findings=none; verification=fixture; verdict=pass";

    const beforeCycleRefusal = snapshot();
    const cycleRefusal = refusedGov(ws,
      `set-review-cycles ${TICKET} --review-cycle ${JSON.stringify(cycleOne)} --review-cycle ${JSON.stringify(cycleTwo)}`);
    assert.match(cycleRefusal, /--replace/);
    assert.deepEqual(snapshot(), beforeCycleRefusal, "missing --replace must not change the plan, projection, board, or journal");

    gov(ws, `set-review-cycles ${TICKET} --replace --review-cycle ${JSON.stringify(cycleThree)}`);
    const beforeInvalidCycle = snapshot();
    const invalidCycleRefusal = refusedGov(ws,
      `set-review-cycles ${TICKET} --replace`);
    assert.match(invalidCycleRefusal, /requires at least one --review-cycle/);
    assert.deepEqual(snapshot(), beforeInvalidCycle, "invalid replacement must preserve the existing evidence byte-for-byte");

    const replacementOutput = JSON.parse(gov(ws,
      `set-review-cycles ${TICKET} --replace --review-cycle ${JSON.stringify(cycleOne)} --review-cycle ${JSON.stringify(cycleTwo)}`));
    let plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.deepEqual(plan.self_review_cycles.map((cycle) => cycle.raw), [cycleOne, cycleTwo], "explicit replacement writes exactly the supplied full set");
    assert.deepEqual(replacementOutput.self_review_cycles.map((cycle) => cycle.raw), [cycleOne, cycleTwo], "the command reports the full resulting collection");
    assert.equal(plan.self_review_cycles.some((cycle) => cycle.raw === cycleThree), false, "replacement removes prior cycles");

    gov(ws, `add-review-cycle ${TICKET} --lens incremental --diff append --risk "state drift" --risk "lost history" --findings none --verification fixture --verdict pass`);
    plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.deepEqual(plan.self_review_cycles.slice(0, 2).map((cycle) => cycle.raw), [cycleOne, cycleTwo], "the incremental verb preserves prior cycle evidence");
    assert.equal(plan.self_review_cycles.length, 3);

    const first = "review note A (no PR)";
    const second = "review note B (no PR)";
    const firstOutput = JSON.parse(gov(ws, `set-pr ${TICKET} --pr ${JSON.stringify(first)}`));
    assert.deepEqual(firstOutput.pr_refs, [first]);

    const appended = JSON.parse(gov(ws, `set-pr ${TICKET} --pr ${JSON.stringify(second)} --pr ${JSON.stringify(first)}`));
    assert.deepEqual(appended.pr_refs, [first, second], "default updates append in stable order and do not silently discard existing refs");
    const deduplicated = JSON.parse(gov(ws, `set-pr ${TICKET} --pr ${JSON.stringify(second)}`));
    assert.deepEqual(deduplicated.pr_refs, [first, second], "repeating an existing ref does not duplicate the resulting collection");
    assert.deepEqual(boardRow(ws).board.pr_index[TICKET], [first, second]);

    const replacement = "replacement review note (no PR)";
    const replaced = JSON.parse(gov(ws, `set-pr ${TICKET} --replace --pr ${JSON.stringify(replacement)}`));
    assert.deepEqual(replaced.pr_refs, [replacement], "--replace reports the exact new collection");
    assert.deepEqual(boardRow(ws).board.pr_index[TICKET], [replacement], "explicit replacement removes the old refs");

    const beforeInvalidRefusal = snapshot();
    const invalidRefusal = refusedGov(ws, `set-pr ${TICKET} --pr ${JSON.stringify("not verified PR evidence")}`);
    assert.match(invalidRefusal, /must either be a merged GitHub PR URL or include/);
    assert.deepEqual(snapshot(), beforeInvalidRefusal, "invalid evidence must leave board, plan, projection, and journal byte-identical");
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test("COORD-638: v2 start requires a held owner lease before effects, then supports immediate mutation", { timeout: 90000 }, () => {
  const ws = makeWorkspace();
  const owner = "codexa00";
  let otherOwner = null;
  const instanceEnv = {
    COORD_PROVIDER: "openai",
    COORD_PROVIDER_SESSION_ID: "coord638-provider-session",
    COORD_INSTANCE_ID: "coord638-start-instance",
    CODEX_THREAD_ID: "coord638-start-thread",
  };
  const worktree = path.join(ws.coordDir, ".worktrees", owner, TICKET);
  const identityRegistry = path.join(ws.coordDir, ".runtime", "identity", "instances.json");
  const legacySessions = path.join(ws.coordDir, "agent_sessions.json");
  const runtimeSessions = path.join(ws.coordDir, ".runtime", "agent_sessions.json");
  const planRecord = path.join(ws.coordDir, ".runtime", "plans", `${TICKET}.json`);
  const readOptional = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const snapshot = () => Object.fromEntries([
    ["board", path.join(ws.coordDir, "board", "tasks.json")],
    ["plan", path.join(ws.coordDir, "PLAN.md")],
    ["planRecord", planRecord],
    ["lock", lockPath(ws)],
    ["runtimeSessions", runtimeSessions],
    ["legacySessions", legacySessions],
    ["agentRegistry", path.join(ws.coordDir, ".runtime", "agents.json")],
    ["legacyAgentRegistry", path.join(ws.coordDir, "agents.json")],
    ["identityRegistry", identityRegistry],
  ].map(([name, file]) => [name, readOptional(file)]).concat([["worktree", fs.existsSync(worktree)]]));
  try {
    gov(ws, `reconcile --reason ${JSON.stringify("fixture genesis baseline")} --human-admin-override ${JSON.stringify("Fixture administrator authorizes this seeded genesis state")}`);
    assert.ok(registeredHandles(ws).includes(owner), "the fixture genesis registry must contain the requested owner");
    otherOwner = registeredHandles(ws).find((handle) => handle !== owner);
    assert.ok(otherOwner, "fixture must provide a second registered owner for mismatch coverage");

    const beforeRefusal = snapshot();
    const refusal = refusedGov(ws, `start ${TICKET} --owner ${owner}`, instanceEnv);
    assert.match(refusal, new RegExp(`gov claim --owner ${owner}`));
    assert.doesNotMatch(refusal, /--handoff/, "handoff guidance is only for a live same-owner conflict");
    assert.deepEqual(snapshot(), beforeRefusal, "a no-lease start must not alter ticket or identity state");

    gov(ws, `claim --owner ${owner}`, instanceEnv);
    gov(ws, `start ${TICKET} --owner ${owner}`, instanceEnv);
    const lock = JSON.parse(fs.readFileSync(lockPath(ws), "utf8"));
    assert.equal(lock.identity_model, "v2");
    assert.equal(lock.session_id, null, "v2 authority must not depend on a legacy lock session token");
    assert.equal(boardRow(ws).row.Owner, owner);
    const assigned = JSON.parse(gov(ws, "agentid --assign", instanceEnv));
    assert.equal(assigned.handle, owner, "assignment on the held owner must not mint a different identity");

    const beforeExplicitMismatch = snapshot();
    const explicitMismatch = refusedGov(ws, `agentid --owner ${otherOwner}`, instanceEnv);
    assert.match(explicitMismatch, new RegExp(`gov claim --owner ${otherOwner} --force`));
    assert.doesNotMatch(explicitMismatch, /gov agentid --owner .*--force/);
    assert.deepEqual(snapshot(), beforeExplicitMismatch, "a rejected explicit rebind does not change identity or ticket state");

    const beforeOwnerMismatch = snapshot();
    const ownerMismatch = refusedGov(ws, `start ${TICKET} --owner ${otherOwner}`, instanceEnv);
    assert.match(ownerMismatch, new RegExp(`gov claim --owner ${otherOwner}`));
    assert.doesNotMatch(ownerMismatch, /--handoff/);
    assert.deepEqual(snapshot(), beforeOwnerMismatch, "a mismatched-owner start leaves ticket and identity state unchanged");

    const secondEnv = {
      ...instanceEnv,
      COORD_PROVIDER_SESSION_ID: "coord638-second-provider-session",
      COORD_INSTANCE_ID: "coord638-second-instance",
      CODEX_THREAD_ID: "coord638-second-thread",
    };
    const beforeConflict = snapshot();
    const conflict = refusedGov(ws, `start ${TICKET} --owner ${owner} --topic ${JSON.stringify("second instance conflict probe")}`, secondEnv);
    assert.match(conflict, /live instance/);
    assert.match(conflict, new RegExp(`gov claim --owner ${owner} --handoff`));
    assert.deepEqual(snapshot(), beforeConflict, "a live lease conflict must be an atomic lifecycle refusal");

    gov(ws, `claim --owner ${owner} --handoff --reason ${JSON.stringify("fixture same-owner transfer")}`, secondEnv);
    refusedGov(ws, `update-plan ${TICKET} --summary ${JSON.stringify("former holder must be refused")}`, instanceEnv);
    const reassigned = JSON.parse(gov(ws, "agentid --assign", secondEnv));
    assert.equal(reassigned.handle, owner, "same-owner handoff keeps the intended identity");
    // The original instance is revoked after handoff; the new lease holder can
    // perform the same ticket mutation using the trusted v2 owner lease.
    gov(ws, `update-plan ${TICKET} --summary ${JSON.stringify("new holder mutation")}`, secondEnv);
    assert.match(fs.readFileSync(planRecord, "utf8"), /new holder mutation/);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

// The agent registry governance itself writes. Used to check an assigned handle
// the way the engine does — by REGISTRATION, not by shape.
function registeredHandles(ws) {
  for (const candidate of [
    path.join(ws.coordDir, ".runtime", "agents.json"),
    path.join(ws.coordDir, "agents.json"),
  ]) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
    const rows = Array.isArray(parsed) ? parsed : parsed.agents || [];
    return rows.map((row) => row && row.handle).filter(Boolean);
  }
  return [];
}

// --------------------------------------------------------------------------

test("COORD-797: explain and plan reject ineligible start statuses without board or lock changes", { timeout: 180000 }, () => {
  for (const status of ["proposed", "review", "done"]) {
    const ws = makeWorkspace();
    try {
      const boardPath = path.join(ws.coordDir, "board", "tasks.json");
      const board = boardRow(ws).board;
      board.sections[0].rows[0].Status = status;
      fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
      reconcileFixture(ws, 'reconcile --reason "fixture genesis" --human-admin-override "Fixture administrator approves seeded state"');
      gov(ws, "agentid --assign");
      const before = fs.readFileSync(boardPath, "utf8");
      const lockBefore = fs.existsSync(lockPath(ws));
      for (const verb of ["explain", "plan"]) {
        const result = JSON.parse(gov(ws, `${verb} ${TICKET}`));
        assert.equal(result.start_readiness.ready, false, `${verb}: ${status}`);
        assert.equal(result.start_readiness.blockers[0].code, "status");
      }
      assert.match(refusedGov(ws, `start ${TICKET}`), /must be todo|must be.*deferred|cannot (?:be )?start/i);
      assert.equal(fs.readFileSync(boardPath, "utf8"), before);
      assert.equal(fs.existsSync(lockPath(ws)), lockBefore);
    } finally {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  }
});

test("COORD-797: eligible todo and deferred tickets retain startup guards and can start", { timeout: 180000 }, () => {
  for (const status of ["todo", "deferred"]) {
    const ws = makeWorkspace();
    try {
      const board = boardRow(ws).board;
      board.sections[0].rows[0].Status = status;
      fs.writeFileSync(path.join(ws.coordDir, "board", "tasks.json"), `${JSON.stringify(board, null, 2)}\n`);
      reconcileFixture(ws, 'reconcile --reason "fixture genesis" --human-admin-override "Fixture administrator approves seeded state"');
      gov(ws, "agentid --assign");
      const unseeded = JSON.parse(gov(ws, `explain ${TICKET}`));
      assert.equal(unseeded.start_readiness.ready, false);
      assert.ok(unseeded.start_readiness.blockers.some((issue) => issue.code === "missing_plan_state"));
      git(ws.root, ["config", "user.email", "fixture@example.com"]);
      git(ws.root, ["config", "user.name", "Fixture"]);
      // The existing start command supplies its governed bootstrap plan.
      gov(ws, `start ${TICKET}`);
      assert.equal(boardRow(ws).row.Status, "doing");
      assert.equal(fs.existsSync(lockPath(ws)), true);
    } finally {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  }
});

test("COORD-653: existing-PR readiness and actual submit refuse TODO, context, and ADR evidence", { timeout: 180000 }, () => {
  const ws = makeWorkspace({ description: "Fixture changes auth policy." });
  try {
    reconcileFixture(ws, `reconcile --reason ${JSON.stringify("fixture genesis baseline")} --human-admin-override ${JSON.stringify("Fixture administrator authorizes this seeded genesis state")}`);
    const assigned = JSON.parse(gov(ws, "agentid --assign"));
    assert.ok(assigned.handle);
    git(ws.root, ["config", "user.email", "fixture@example.com"]);
    git(ws.root, ["config", "user.name", "Fixture"]);
    gov(ws, `start ${TICKET}`);
    gov(ws, `set-pr ${TICKET} --pr ${JSON.stringify("local-review (no PR)")}`);

    // Existing refs used to make explain say ready without consulting the
    // review collector. Submit then executes the real doing -> review path
    // while the plan still contains scaffold cycles and high-impact evidence
    // is absent.
    const explanation = JSON.parse(gov(ws, `explain ${TICKET}`));
    assert.equal(explanation.submit_readiness.ready, false);
    assert.ok(explanation.submit_readiness.blockers.some((blocker) => /self-review|review cycle/i.test(blocker.message)));
    const refusal = refusedGov(ws, `submit ${TICKET}`);
    assert.match(refusal, /self-review cycle|review cycle/i, "TODO self-review scaffolds must refuse the real lifecycle transition");
    assert.match(refusal, /context_pack_ack/i, "context acknowledgement refusal must be produced by the real transition");
    assert.match(refusal, /accepted ADR ref|ADR-aware self-review evidence/i, "high-impact ADR evidence refusal must be produced by the real transition");

    assert.equal(boardRow(ws).row.Status, "doing", "refused submit must leave the ticket in doing");
    assert.deepEqual(boardRow(ws).board.pr_index[TICKET].map((entry) => entry.pr || entry), ["local-review (no PR)"], "refused submit must preserve the existing PR reference");
    assert.equal(fs.existsSync(lockPath(ws)), true, "refused submit must retain the active lock");
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test("COORD-545: public guided-closeout shares context and ADR review gates with finalize", { timeout: 180000 }, () => {
  const ws = makeWorkspace({ description: "This fixture changes the authz policy." });
  try {
    reconcileFixture(ws, `reconcile --reason ${JSON.stringify("fixture genesis baseline")} --human-admin-override ${JSON.stringify("Fixture administrator authorizes this seeded genesis state")}`);
    const assigned = JSON.parse(gov(ws, "agentid --assign"));
    assert.ok(assigned.handle);
    git(ws.root, ["config", "user.email", "fixture@example.com"]);
    git(ws.root, ["config", "user.name", "Fixture"]);
    gov(ws, `start ${TICKET}`);

    const reviewCycles = [1, 2, 3].map((n) =>
      `lens=contract ${n}; diff=coord/engine/scripts/guided-closeout.js; risks=missing gate parity, stale readiness; findings=none; verification=fixture review probe; verdict=pass`
    );
    gov(ws, `set-review-cycles ${TICKET} --replace ${reviewCycles.map((cycle) => `--review-cycle ${JSON.stringify(cycle)}`).join(" ")}`);
    gov(ws, `update-plan ${TICKET} --files coord/engine/scripts/guided-closeout.js --verify ${JSON.stringify("node --test coord/engine/scripts/guided-closeout.test.js")} --repo-gate ${JSON.stringify("node --test coord/engine/scripts/guided-closeout.test.js: pass")} --closure ${JSON.stringify("Ticket ask: keep guided-closeout aligned with finalize")} --closure ${JSON.stringify("Implemented: fixture has complete legacy checklist evidence")} --closure ${JSON.stringify("Not implemented: none")} --closure ${JSON.stringify("Deferred to: none")} --closure ${JSON.stringify("Closeout verdict: complete")} --invariant ${JSON.stringify("business-context investigation: not-required; fixture only")} --invariant ${JSON.stringify("decision status: not-required; fixture only")}`);
    gov(ws, `add-feature-proof ${TICKET} --proof-path coord/engine/scripts/guided-closeout.js`);
    gov(ws, `update-plan ${TICKET} --gate-plan ${JSON.stringify(JSON.stringify({ selected_gates: [] }))}`);

    const guidance = JSON.parse(gov(ws, `guided-closeout ${TICKET} --json`));
    for (const id of ["plan_record", "review_cycles", "repo_gates", "requirement_closure", "feature_proof", "feature_proof_committed", "gate_plan", "business_context_disposition"]) {
      assert.equal(guidance.checks.find((check) => check.id === id).ok, true, `legacy checklist ${id} must pass before testing new review gates`);
    }
    const review = guidance.checks.find((check) => check.id === "review_plan");
    assert.ok(review, "public guided-closeout must expose the canonical review-plan gate");
    const codes = review.issues.map((issue) => issue.code);
    assert.ok(codes.includes("context_pack_ack"), `missing context ack code in ${codes.join(", ")}`);
    assert.ok(codes.includes("adr_review_cycle"), `missing ADR review code in ${codes.join(", ")}`);
    assert.equal(guidance.ready, false);
    assert.match(guidance.readiness_scope, /Git, remote, ownership, lock, PR, and landing/);

    const beforeMissingAckRefusal = {
      board: fs.readFileSync(path.join(ws.coordDir, "board", "tasks.json"), "utf8"),
      plan: fs.readFileSync(path.join(ws.coordDir, ".runtime", "plans", `${TICKET}.json`), "utf8"),
      lock: fs.readFileSync(lockPath(ws), "utf8"),
    };
    const missingAckRefusal = refusedGov(ws, `finalize ${TICKET} --no-pr --landed ${JSON.stringify("fixture missing-ack refusal")}`);
    assert.match(missingAckRefusal, /context_pack_ack/i);
    assert.match(missingAckRefusal, /ADR-aware self-review evidence/i);
    assert.equal(fs.readFileSync(path.join(ws.coordDir, "board", "tasks.json"), "utf8"), beforeMissingAckRefusal.board);
    assert.equal(fs.readFileSync(path.join(ws.coordDir, ".runtime", "plans", `${TICKET}.json`), "utf8"), beforeMissingAckRefusal.plan);
    assert.equal(fs.readFileSync(lockPath(ws), "utf8"), beforeMissingAckRefusal.lock);

    const unknown = JSON.parse(gov(ws, "guided-closeout MISSING-99 --json"));
    assert.equal(unknown.ready, false);
    assert.equal(unknown.checks.find((check) => check.id === "ticket_exists").ok, false);
    assert.equal(unknown.checks.find((check) => check.id === "review_plan").assessed, false);

    const acknowledgement = {
      considered: {
        active_constraints: ["none"],
        adrs: ["none"],
        business_rules: ["none"],
        conflicts: ["none"],
        stale_warnings: ["none"],
        open_questions: ["none"],
      },
      authority: { constraints: ["none"], advisory_only: ["none"] },
      closeout_learning: { decision: "scratch-only", rationale: "Fixture has no reusable learning." },
    };
    gov(ws, `update-plan ${TICKET} --context-pack-ack ${JSON.stringify(JSON.stringify(acknowledgement))}`);
    const acknowledged = JSON.parse(gov(ws, `guided-closeout ${TICKET} --json`));
    const acknowledgedReview = acknowledged.checks.find((check) => check.id === "review_plan");
    assert.equal(acknowledgedReview.issues.some((issue) => issue.code.startsWith("context_pack_ack")), false);
    assert.ok(acknowledgedReview.issues.some((issue) => issue.code === "adr_review_cycle"), "ADR evidence remains independently required");

  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test("COORD-545: public guided-closeout rejects blocked status without lifecycle side effects", { timeout: 180000 }, () => {
  const ws = makeWorkspace();
  try {
    const boardFile = path.join(ws.coordDir, "board", "tasks.json");
    const board = JSON.parse(fs.readFileSync(boardFile, "utf8"));
    board.sections[0].rows[0].Status = "doing (blocked: fixture prerequisite)";
    fs.writeFileSync(boardFile, `${JSON.stringify(board, null, 2)}\n`);
    const planFile = path.join(ws.coordDir, ".runtime", "plans", `${TICKET}.json`);
    const plan = {
      ticket_id: TICKET,
      self_review_cycles: [1, 2, 3].map((n) => ({
        cycle: n,
        total: 3,
        raw: `lens=contract ${n}; diff=fixture source; risks=authority mismatch, stale evidence; findings=none; verification=fixture probe; verdict=pass`,
        lens: `contract ${n}`,
        diff: "fixture source",
        risks: ["authority mismatch", "stale evidence"],
        findings: "none",
        verification: "fixture probe",
        verdict: "pass",
      })),
      repo_gates: ["fixture gate recorded"],
      requirement_closure: [
        "Ticket ask: fixture readiness",
        "Implemented: fixture report",
        "Not implemented: none",
        "Deferred to: none",
        "Closeout verdict: complete",
      ],
      feature_proof: ["path:coord/GOVERNANCE.md"],
      gate_plan: { selected_gates: [] },
      critical_invariants: ["business-context investigation: not-required; fixture only"],
    };
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);

    const guidance = JSON.parse(gov(ws, `guided-closeout ${TICKET} --json`));
    assert.equal(guidance.ready, false);
    assert.equal(guidance.checks.find((check) => check.id === "finalize_status").ok, false);
    assert.equal(guidance.status, "doing (blocked: fixture prerequisite)");
    assert.equal(
      guidance.checks.find((check) => check.id === "review_plan").issues.some((issue) => issue.code.startsWith("context_pack_ack")),
      false,
      "context acknowledgement stays conditional for an ordinary low-risk ticket",
    );

    const beforeBoard = fs.readFileSync(boardFile, "utf8");
    const beforePlan = fs.readFileSync(planFile, "utf8");
    const refusal = refusedGov(ws, `finalize ${TICKET} --no-pr --landed ${JSON.stringify("fixture status refusal")}`);
    assert.match(refusal, /must be doing or review/);
    assert.equal(fs.readFileSync(boardFile, "utf8"), beforeBoard);
    assert.equal(fs.readFileSync(planFile, "utf8"), beforePlan);
    assert.equal(fs.existsSync(lockPath(ws)), false);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test("COORD-645-F3: a REAL governed lifecycle runs end to end with the barrier active, and the barrier still bites", { timeout: 240000 }, () => {
  const ws = makeWorkspace();

  // --- GREEN CASE 1: no active lock -> the barrier does not engage. ---------
  const canonicalDoc = path.join(ws.coordDir, "GOVERNANCE.md");
  const beforeGovernance = fs.readFileSync(canonicalDoc, "utf8");
  assert.equal(
    askHook(ws, { tool_name: "Write", tool_input: { file_path: path.join(ws.root, "bootstrap-note.md"), content: "x" } }).status,
    0,
    "bootstrap/adoption writes must be unblocked when no ticket is in flight"
  );
  assert.equal(
    askHook(ws, { tool_name: "Bash", tool_input: { command: `echo x > ${canonicalDoc}` } }).status,
    0,
    "with no active lock even a canonical shell write is permitted"
  );
  assert.equal(
    askHook(ws, { tool_name: "Bash", tool_input: { command: "rm -rf build" } }).status,
    0,
    "with no active lock destructive shell is permitted"
  );

  // --- genesis + identity -------------------------------------------------
  reconcileFixture(ws, `reconcile --reason ${JSON.stringify("fixture genesis baseline")} --human-admin-override ${JSON.stringify("Fixture administrator authorizes this seeded genesis state")}`);
  const assigned = JSON.parse(gov(ws, "agentid --assign"));
  const owner = assigned.handle;
  // COORD-645-F4: this asserted /^claudea\d+$/ — an ANTHROPIC-shaped handle in a
  // deliberately provider-neutral fixture. A hermetic workspace exports no
  // provider environment, so `providerConfig` finds no match and
  // governance-session.js falls back to handlePrefix "agent", legitimately
  // assigning e.g. `agenta34`. The canonical aggregate caught it; the focused
  // run passed only because its identity allocation happened to produce a
  // Claude-shaped handle — luck, not evidence.
  //
  // The engine's own test is REGISTRATION, not shape (`isRegisteredAgentHandle`
  // = resolve the handle against the agents registry). Assert that instead: it
  // is provider-neutral by construction and cannot rot when a provider is added
  // to PROVIDER_REGISTRY, which a widened prefix alternation would.
  assert.ok(owner, "agentid --assign must return a handle");
  assert.ok(
    registeredHandles(ws).includes(owner),
    `assigned handle ${owner} must be registered in the fixture's agent registry`
  );

  // The governed commits below run in linked worktrees and cannot inherit the
  // per-invocation -c identity used by this fixture's setup helper. Configure
  // the isolated repository only after provider-neutral identity assignment,
  // keeping both concerns hermetic on runners with no global Git identity.
  git(ws.root, ["config", "user.email", "fixture@example.com"]);
  git(ws.root, ["config", "user.name", "Fixture"]);

  // --- todo -> doing ------------------------------------------------------
  assert.equal(boardRow(ws).row.Status, "todo");
  assert.equal(fs.existsSync(lockPath(ws)), false);
  gov(ws, `start ${TICKET}`);

  const started = boardRow(ws).row;
  assert.equal(started.Status, "doing", "start must move the board row to doing");
  assert.equal(started.Owner, owner, "start must bind the ticket to the acting owner");

  assert.equal(fs.existsSync(lockPath(ws)), true, "start must create the governed lock");
  const lock = JSON.parse(fs.readFileSync(lockPath(ws), "utf8"));
  assert.equal(lock.status, "doing");
  assert.equal(lock.owner, owner);
  assert.equal(lock.ticket, TICKET);
  const worktree = lock.worktree;
  assert.equal(fs.existsSync(worktree), true, "start must materialise the ticket worktree");

  // --- GREEN CASE 2: the owner works inside its own worktree. -------------
  const workFile = path.join(worktree, "src", "fix.txt");
  guardedWrite(ws, workFile, "fixed\n");
  assert.equal(fs.readFileSync(workFile, "utf8"), "fixed\n", "the write actually happened");

  // --- THE BARRIER STILL BITES, mid-lifecycle, with the lock live. --------
  const refusal = refusedWrite(ws, canonicalDoc, "compromised\n");
  assert.match(refusal, /CONCORD DENY \[canonical_write_refused\]/);
  assert.match(refusal, new RegExp(TICKET));
  assert.equal(fs.readFileSync(canonicalDoc, "utf8"), beforeGovernance, "canonical doc must be byte-identical after refusal");

  const shellRefusal = askHook(ws, {
    tool_name: "Bash",
    tool_input: { command: `node ${path.join(ws.coordDir, "scripts", "governance.js")} explain ${TICKET}; echo compromised > ${canonicalDoc}` },
  });
  assert.equal(shellRefusal.status, 2, "COORD-645-F1: a gov invocation must not exempt the rest of a compound command");
  assert.equal(fs.readFileSync(canonicalDoc, "utf8"), beforeGovernance);

  // --- doing -> commit ----------------------------------------------------
  gov(ws, `update-plan ${TICKET} --files src/fix.txt`);
  guardedRun(ws, `git ${GIT.join(" ")} -C ${JSON.stringify(worktree)} add -- src/fix.txt`);
  gov(ws, `commit ${TICKET} --files src/fix.txt --message ${JSON.stringify("fix: fixture ticket work")}`);

  const branch = lock.branch;
  const subject = gitFixtureSpawn(worktree, ["log", "-1", "--pretty=%s"]).stdout.trim();
  assert.equal(subject, "fix: fixture ticket work", "gov commit must produce a REAL git commit");
  const committed = gitFixtureSpawn(worktree, ["show", "--name-only", "--pretty=", "HEAD"]).stdout;
  assert.match(committed, /src\/fix\.txt/, "the commit must contain the file the lifecycle wrote");

  // --- doing -> review ----------------------------------------------------
  gov(ws, `update-plan ${TICKET} --repo-gate ${JSON.stringify("not-required")}`);
  for (const lens of ["correctness", "regression", "security"]) {
    gov(
      ws,
      `add-review-cycle ${TICKET} --lens ${lens} --diff ${JSON.stringify("src/fix.txt added")} ` +
        `--risk r1 --risk r2 --findings none --verification true --verdict pass`
    );
  }
  const readyExplanation = JSON.parse(gov(ws, `explain ${TICKET}`));
  assert.equal(readyExplanation.submit_readiness.ready, true, "a fully evidenced doing ticket must report ready before the real submit");
  gov(ws, `submit ${TICKET} --fill --pr ${JSON.stringify("local-review (no PR)")}`);

  assert.equal(boardRow(ws).row.Status, "review", "submit must move the board row to review");
  assert.equal(fs.existsSync(lockPath(ws)), false, "submit must RELEASE the governed lock");
  assert.deepEqual(boardRow(ws).board.pr_index[TICKET].map((e) => e.pr || e), ["local-review (no PR)"]);
  const repeatedSubmit = JSON.parse(gov(ws, `submit ${TICKET}`));
  assert.equal(repeatedSubmit.status, "already_review", "submit remains idempotent once the ticket is already in review");
  assert.equal(boardRow(ws).row.Status, "review");

  // --- review -> done (closeout) -----------------------------------------
  guardedRun(ws, `git ${GIT.join(" ")} -C ${JSON.stringify(ws.root)} merge --no-ff -q -m ${JSON.stringify(`merge ${TICKET}`)} ${branch}`);
  gov(ws, `finalize ${TICKET} --no-pr --already-landed --landed ${JSON.stringify("fixture local landing")}`);

  assert.equal(boardRow(ws).row.Status, "done", "finalize must close the ticket out");
  const landing = boardRow(ws).board.landing_index[TICKET];
  assert.ok(landing, "closeout must record landing evidence");
  assert.match(JSON.stringify(landing), /fixture local landing/);
  assert.equal(fs.existsSync(worktree), false, "closeout must clean up the ticket worktree");

  // --- the barrier really was in the loop --------------------------------
  assert.ok(hookCalls.length >= 15, `expected the barrier to gate every step, saw ${hookCalls.length}`);
  assert.equal(hookCalls.filter((c) => c.status === 2).length, 2, "exactly the two injected violations were refused");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("COORD-796: public submit readiness refuses unmet dependencies and accepts a completed dependency", { timeout: 180000 }, () => {
  const ws = makeWorkspace();
  const oldPath = process.env.PATH;
  try {
    const boardFile = path.join(ws.coordDir, "board", "tasks.json");
    const seeded = JSON.parse(fs.readFileSync(boardFile, "utf8"));
    for (const [id, status] of [["DEP-1", "todo"], ["DEP-2", "done"]]) {
      seeded.sections[0].rows.push({
        ID: id, Repo: "X", Type: "bug", Pri: "P2", Status: status,
        Owner: "unassigned", Description: "Synthetic fixture prerequisite.", "Depends On": "",
      });
    }
    // Synthetic terminal fixture evidence points to an actual local seed commit.
    // It is test input for the production dependency evaluator, not qualification.
    const seedCommit = git(ws.root, ["rev-parse", "HEAD"]);
    seeded.landing_index["DEP-2"] = {
      recorded_at: new Date().toISOString(), base_ref: "main", method: "no_pr",
      commit_sha: seedCommit, source_commit_sha: seedCommit,
      evidence: ["Synthetic fixture: prerequisite represented by local seed commit."],
    };
    fs.writeFileSync(boardFile, `${JSON.stringify(seeded, null, 2)}\n`);
    reconcileFixture(ws, 'reconcile --reason "fixture genesis" --human-admin-override "Fixture administrator approves seeded state"');
    gov(ws, "agentid --assign");
    git(ws.root, ["config", "user.email", "fixture@example.com"]);
    git(ws.root, ["config", "user.name", "Fixture"]);
    gov(ws, `start ${TICKET}`);
    const cycles = [1, 2, 3].map((n) =>
      `lens=contract ${n}; diff=fixture source; risks=dependency mismatch, stale evidence; findings=none; verification=fixture probe; verdict=pass`
    );
    gov(ws, `set-review-cycles ${TICKET} --replace ${cycles.map((cycle) => `--review-cycle ${JSON.stringify(cycle)}`).join(" ")}`);
    const planArgs = [
      "update-plan", TICKET, "--files", "coord/GOVERNANCE.md", "--verify", "fixture probe",
      "--repo-gate", "fixture gate: pass", "--closure", "Ticket ask: fixture dependency readiness",
      "--closure", "Implemented: fixture plan evidence", "--closure", "Not implemented: none",
      "--closure", "Deferred to: none", "--closure", "Closeout verdict: complete",
      "--invariant", "business-context investigation: not-required; fixture only",
      "--invariant", "decision status: not-required; fixture only",
    ];
    gov(ws, planArgs.map((arg) => JSON.stringify(arg)).join(" "));
    gov(ws, `add-feature-proof ${TICKET} --proof-path coord/GOVERNANCE.md`);
    gov(ws, `set-pr ${TICKET} --pr "local-review (no PR)"`);
    const clear = JSON.parse(gov(ws, `explain ${TICKET}`));
    assert.equal(clear.submit_readiness.ready, true, JSON.stringify(clear.submit_readiness));

    gov(ws, `set-followup-relation ${TICKET} --depends-on DEP-1 --relation blocking`);
    const explanation = JSON.parse(gov(ws, `explain ${TICKET}`));
    assert.equal(explanation.readiness.ready, false);
    assert.equal(explanation.submit_readiness.ready, false);
    assert.deepEqual(explanation.submit_readiness.blockers.map((entry) => entry.code), ["dependencies"]);
    assert.match(explanation.submit_readiness.blockers[0].message, /still has unmet dependencies: DEP-1/);
    assert.ok(explanation.submit_readiness.blockers[0].next_steps.length > 0);

    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord796-no-network-"));
    const networkMarker = path.join(sentinelDir, "invoked");
    try {
      fs.writeFileSync(path.join(sentinelDir, "gh"), '#!/bin/sh\nprintf invoked > "$(dirname "$0")/invoked"\nexit 97\n', { mode: 0o755 });
      process.env.PATH = `${sentinelDir}${path.delimiter}${oldPath}`;
      assert.equal(git(ws.root, ["remote"]), "", "fixture has no Git network destination");
      const paths = [boardFile, lockPath(ws), path.join(ws.coordDir, ".runtime", "plans", `${TICKET}.json`)];
      const before = paths.map((file) => fs.readFileSync(file, "utf8"));
      const refusal = refusedGov(ws, `submit ${TICKET} --pr "local-review (no PR)"`);
      assert.match(refusal, /still has unmet dependencies: DEP-1/);
      paths.forEach((file, index) => assert.equal(fs.readFileSync(file, "utf8"), before[index], file));
      assert.equal(fs.existsSync(networkMarker), false, "refusal must not invoke external PR tooling");
      assert.equal(boardRow(ws).row.Status, "doing");
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(sentinelDir, { recursive: true, force: true });
    }

    gov(ws, `set-followup-relation ${TICKET} --depends-on DEP-2 --relation blocking --replace`);
    const satisfied = JSON.parse(gov(ws, `explain ${TICKET}`));
    assert.deepEqual(satisfied.readiness.deps, ["DEP-2"]);
    assert.equal(satisfied.readiness.ready, true);
    assert.equal(satisfied.submit_readiness.ready, true, JSON.stringify(satisfied.submit_readiness));
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test("COORD-798: public proof writer and actual closeout reject unsupported coord prefixes atomically", { timeout: 240000 }, () => {
  const ws = makeWorkspace({ description: "Fixture proof contract exercises a normal feature closeout." });
  try {
    // Use a real configured product repository so closeout runs the feature-
    // proof audit (Repo X intentionally does not run that product audit).
    const boardPath = path.join(ws.coordDir, "board", "tasks.json");
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const row = board.sections.flatMap((section) => section.rows || []).find((entry) => entry.ID === TICKET);
    assert.ok(row);
    row.Repo = "F";
    board.metadata.feature_proof_required_from_ticket = { F: TICKET };
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

    const frontendRoot = path.join(ws.root, "frontend");
    fs.mkdirSync(path.join(frontendRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(frontendRoot, "src", "proof.js"), "function FixtureProofSymbol() {}\n", "utf8");
    git(frontendRoot, ["add", "src/proof.js"]);
    git(frontendRoot, ["commit", "-m", "seed proof target"]);

    reconcileFixture(ws, `reconcile --reason ${JSON.stringify("COORD-798 proof fixture genesis")} --human-admin-override ${JSON.stringify("Isolated fixture authorizes its synthetic genesis state")}`);
    const assigned = JSON.parse(gov(ws, "agentid --assign"));
    assert.ok(assigned.handle);
    git(frontendRoot, ["config", "user.email", "fixture@example.com"]);
    git(frontendRoot, ["config", "user.name", "Fixture"]);
    gov(ws, `start ${TICKET}`);

    const worktree = JSON.parse(fs.readFileSync(lockPath(ws), "utf8")).worktree;
    const branch = JSON.parse(fs.readFileSync(lockPath(ws), "utf8")).branch;
    guardedWrite(ws, path.join(worktree, "src", "change.js"), "module.exports = true;\n");
    const validProofs = [
      "path:src/proof.js",
      "symbol:src/proof.js#FixtureProofSymbol",
    ];
    gov(ws,
      `update-plan ${TICKET} --files ${JSON.stringify("src/change.js")} ` +
      `--summary ${JSON.stringify("Exercise the public proof writer and closeout against a fixture repository.")} ` +
      `--verify ${JSON.stringify("node --test coord/scripts/runtime-authority-lifecycle.test.js")} ` +
      `--startup completed --traceability verified ` +
      `--baseline ${JSON.stringify("Command: fixture frontend proof setup and public gov update-plan.")} ` +
      `--baseline ${JSON.stringify("Outcome: ordinary path and symbol proofs are accepted and record their canonical refs.")} ` +
      `--invariant ${JSON.stringify("Proof entries, parsed kinds and recorded refs must agree.")} ` +
      `--invariant ${JSON.stringify("Closeout evaluates every recorded proof against the ticket repository and ref.")} ` +
      `--closure ${JSON.stringify("Ticket ask: keep proof syntax and closeout evaluation consistent")} ` +
      `--closure ${JSON.stringify("Implemented: isolated public writer and closeout regression fixture")} ` +
      `--closure ${JSON.stringify("Not implemented: none")} ` +
      `--closure ${JSON.stringify("Deferred to: none")} ` +
      `--closure ${JSON.stringify("Closeout verdict: complete")} ` +
      `--repo-gate ${JSON.stringify("node --test coord/scripts/runtime-authority-lifecycle.test.js")} ` +
      `--rollback ${JSON.stringify("revert the fixture ticket commit")} ` +
      `--security no --feature-proof ${JSON.stringify(validProofs[0])} ` +
      `--feature-proof ${JSON.stringify(validProofs[1])}`
    );

    const planPath = path.join(ws.coordDir, ".runtime", "plans", `${TICKET}.json`);
    const originalPlanBytes = fs.readFileSync(planPath);
    const originalPlan = JSON.parse(originalPlanBytes);
    assert.deepEqual(originalPlan.feature_proof, validProofs);
    assert.deepEqual(Object.keys(originalPlan.feature_proof_refs).sort(), validProofs.slice().sort());

    const fixtureSnapshotPaths = [
      boardPath,
      planPath,
      path.join(ws.coordDir, "PLAN.md"),
      path.join(ws.coordDir, ".runtime", "governance-events.ndjson"),
      lockPath(ws),
    ];
    const snapshot = () => fixtureSnapshotPaths.map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null);
    const beforeRefusal = snapshot();
    for (const entry of [
      "coord:path:src/proof.js",
      "coord:symbol:src/proof.js#FixtureProofSymbol",
      "unknown:path:src/proof.js",
    ]) {
      const refusal = refusedGov(ws, `update-plan ${TICKET} --feature-proof ${JSON.stringify(entry)}`);
      assert.match(refusal, /Cross-repository proof prefixes are unsupported/);
      assert.deepEqual(snapshot(), beforeRefusal, `${entry} must not change plan, proof refs, board, journal, or lock`);
    }

    guardedRun(ws, `git ${GIT.join(" ")} -C ${JSON.stringify(worktree)} add -A`);
    gov(ws, `commit ${TICKET} --message ${JSON.stringify("test: exercise supported proof closeout")} --files ${JSON.stringify("src/change.js")}`);
    const recordCommit = git(worktree, ["rev-parse", "HEAD"]);
    assert.ok(recordCommit);
    for (const [index, lens] of [
      "contract/state invariants",
      "auth/security/failure modes",
      "tests/operability/performance",
      "requirement closure",
    ].entries()) {
      gov(ws,
        `add-review-cycle ${TICKET} --lens ${JSON.stringify(lens)} ` +
        `--diff ${JSON.stringify("isolated public feature-proof writer and closeout fixture")} ` +
        `--risk ${JSON.stringify(`risk ${index + 1}a`)} --risk ${JSON.stringify(`risk ${index + 1}b`)} ` +
        `--findings none --verification ${JSON.stringify("node --test coord/scripts/runtime-authority-lifecycle.test.js")} --verdict pass`
      );
    }
    // COORD-977: src/change.js is a new non-test module, so the reuse lens is required.
    gov(ws,
      `add-review-cycle ${TICKET} --lens ${JSON.stringify("reuse")} ` +
      `--diff ${JSON.stringify("src/change.js new module")} ` +
      `--risk ${JSON.stringify("duplicate helper")} --risk ${JSON.stringify("missed existing guard")} ` +
      `--findings ${JSON.stringify("searched: coord/engine/scripts/integration-base-ref.js; reused integration-base-ref.js for the base ref")} ` +
      `--verification ${JSON.stringify("node --test coord/engine/scripts/runtime-authority-lifecycle.test.js")} --verdict pass`
    );
    gov(ws, `submit ${TICKET} --fill --pr ${JSON.stringify("local-review (no PR)")}`);
    const qualifiedPlanBytes = fs.readFileSync(planPath);
    const qualifiedPlan = JSON.parse(qualifiedPlanBytes);
    git(frontendRoot, ["merge", "--no-ff", "-q", "-m", `merge ${TICKET}`, branch]);

    for (const entry of [
      "coord:path:src/proof.js",
      "coord:symbol:src/proof.js#FixtureProofSymbol",
      "unknown:path:src/proof.js",
    ]) {
      const malformedLegacyPlan = { ...qualifiedPlan, feature_proof: [entry] };
      malformedLegacyPlan.feature_proof_refs = {
        [entry]: qualifiedPlan.feature_proof_refs[validProofs[0]],
      };
      fs.writeFileSync(planPath, `${JSON.stringify(malformedLegacyPlan, null, 2)}\n`, "utf8");
      gov(ws,
        `reconcile --reason ${JSON.stringify(`Seed isolated legacy record ${entry} before closeout audit`)} ` +
        `--human-admin-override ${JSON.stringify("The temporary lifecycle fixture authorizes its synthetic legacy-state reconciliation")}`
      );
      const beforeCloseoutRefusal = snapshot();
      const refusal = refusedGov(ws, `finalize ${TICKET} --no-pr --already-landed --landed ${JSON.stringify(`${recordCommit} isolated fixture landing`)}`);
      assert.match(refusal, /invalid feature-proof entries:.*unsupported proof kind/);
      assert.deepEqual(snapshot(), beforeCloseoutRefusal, `${entry} closeout refusal must preserve canonical fixture state`);
      assert.equal(boardRow(ws).row.Status, "review");
    }

    fs.writeFileSync(planPath, qualifiedPlanBytes);
    gov(ws,
      `reconcile --reason ${JSON.stringify("Restore isolated valid proof record before successful closeout")} ` +
      `--human-admin-override ${JSON.stringify("The temporary lifecycle fixture authorizes restoration of its supported proof record")}`
    );
    gov(ws, `finalize ${TICKET} --no-pr --already-landed --landed ${JSON.stringify(`${recordCommit} isolated fixture landing with supported proofs`)}`);
    assert.equal(boardRow(ws).row.Status, "done", "supported unprefixed path and symbol proofs must close successfully");
    assert.ok(boardRow(ws).board.landing_index[TICKET]);
    assert.equal(fs.existsSync(lockPath(ws)), false);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test("COORD-720: public commit refuses every outsider atomically and journals exact acknowledged paths", { timeout: 180000 }, () => {
  const ws = makeWorkspace();
  try {
    reconcileFixture(ws, `reconcile --reason "fixture genesis" --human-admin-override "Fixture administrator authorizes seeded genesis"`);
    gov(ws, "agentid --assign");
    git(ws.root, ["config", "user.email", "fixture@example.com"]);
    git(ws.root, ["config", "user.name", "Fixture"]);
    gov(ws, `start ${TICKET}`);
    gov(ws, `update-plan ${TICKET} --files src/fix.txt`);
    const worktree = JSON.parse(fs.readFileSync(lockPath(ws))).worktree;
    for (const file of ["src/fix.txt", "outside-one.txt", "outside-two.txt"]) {
      guardedWrite(ws, path.join(worktree, file), "new ticket content\n");
    }
    guardedRun(ws, `git -C ${JSON.stringify(worktree)} add -- outside-one.txt outside-two.txt`);
    const index = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const tracked = ["board/tasks.json", "PLAN.md", ".runtime/governance-events.ndjson"];
    const before = tracked.map((file) => fs.readFileSync(path.join(ws.coordDir, file)));
    const indexBefore = fs.readFileSync(index);
    const head = git(worktree, ["rev-parse", "HEAD"]);
    const commitCount = () => git(worktree, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"])
      .split("\n").filter((type) => type === "commit").length;
    const commitsBefore = commitCount();
    for (const selection of ["", "--all", "--files src/fix.txt"]) {
      const refusal = refusedGov(ws, `commit ${TICKET} --message "must refuse" ${selection}`);
      assert.match(refusal, /Commit scope refused/);
      assert.match(refusal, /outside-one\.txt/); assert.match(refusal, /outside-two\.txt/);
      assert.equal(git(worktree, ["rev-parse", "HEAD"]), head);
      assert.equal(commitCount(), commitsBefore, "refusal must not even create a dangling commit object");
      assert.deepEqual(fs.readFileSync(index), indexBefore);
      assert.deepEqual(tracked.map((file) => fs.readFileSync(path.join(ws.coordDir, file))), before);
    }
    gov(ws, `commit ${TICKET} --message "explicit exceptions" --files src/fix.txt --ack-outside-scope outside-one.txt --ack-outside-scope outside-two.txt`);
    const events = fs.readFileSync(path.join(ws.coordDir, ".runtime/governance-events.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const event = events.filter((entry) => entry.command === "commit").at(-1);
    assert.equal(event.result, "succeeded");
    assert.deepEqual(event.details.declared_files, ["src/fix.txt"]);
    assert.deepEqual(event.details.acknowledged_outside_scope, ["outside-one.txt", "outside-two.txt"]);
    assert.deepEqual(event.details.staged_files, ["outside-one.txt", "outside-two.txt", "src/fix.txt"]);
    assert.equal(event.details.source_commit_sha, git(worktree, ["rev-parse", "HEAD"]));
    assert.equal(commitCount(), commitsBefore + 1);
    assert.deepEqual(git(worktree, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n"), event.details.staged_files);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test("COORD-748: setPrRefs factory contract preserves, deduplicates, replaces, and skips sync explicitly", () => {
  const createLifecycleTicketAdmin = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-ticket-admin.js"));
  const ticket = "COORD-748";
  const row = { ID: ticket, Repo: "X", Status: "review", Owner: "codexa742" };
  const board = { pr_index: { [ticket]: ["old (no PR)", "kept (no PR)"] } };
  const writes = [];
  const syncs = [];
  const admin = createLifecycleTicketAdmin({
    STATUS: { DONE: "done" },
    fail(message) { throw new Error(message); },
    inferTicketStatus: () => row.Status,
    stableIdempotencyKey: (_command, _ticket, payload) => JSON.stringify(payload),
    toArray: value => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value],
    withGovernanceMutation: (_mutation, action) => action(),
    readBoard: () => board,
    getTicketRef: (_board, id) => id === ticket ? { row } : null,
    verifyPrEvidence: (_id, refs, options) => {
      assert.ok(refs.length > 0);
      assert.equal(options.allowNoPr, true);
    },
    withCoordStateLock: action => action(),
    setTicketPrRefs: (target, id, refs) => {
      assert.equal(target, board);
      writes.push([...refs]);
      target.pr_index[id] = [...refs];
    },
    writeBoard: () => {},
    runBoardSync: options => syncs.push(options),
  });
  const initialLog = console.log;
  console.log = () => {};
  try {
    admin.setPrRefs(ticket, { pr: ["new (no PR)", "kept (no PR)", "new (no PR)"] });
    assert.deepEqual(writes.at(-1), ["old (no PR)", "kept (no PR)", "new (no PR)"],
      "default setter merges in stable order and removes both existing and input duplicates");
    assert.equal(syncs.length, 1);

    admin.setPrRefs(ticket, { pr: ["replacement (no PR)"], replace: true, skipSync: true });
    assert.deepEqual(writes.at(-1), ["replacement (no PR)"], "explicit replacement removes all prior references");
    assert.equal(syncs.length, 1, "skipSync suppresses only the projection sync");

    for (const [id, options, pattern] of [
      [undefined, { pr: ["ref (no PR)"] }, /requires <ticket-id>/],
      [ticket, { pr: [] }, /requires at least one --pr/],
      ["COORD-MISSING", { pr: ["ref (no PR)"] }, /Unknown ticket/],
    ]) {
      const beforeBoard = structuredClone(board);
      const beforeWrites = writes.length;
      const beforeSyncs = syncs.length;
      assert.throws(() => admin.setPrRefs(id, options), pattern);
      assert.deepEqual(board, beforeBoard);
      assert.equal(writes.length, beforeWrites);
      assert.equal(syncs.length, beforeSyncs);
    }
  } finally {
    console.log = initialLog;
  }
});
