"use strict";

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

const ENGINE_COORD = path.resolve(__dirname, "..");
const HOOK = path.join(__dirname, "runtime-authority-hook.js");
const TICKET = "FIX-1";

const GIT = ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture"];

function git(cwd, args) {
  const res = spawnSync("git", [...GIT, ...args], { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

// A real engine in a temp workspace. Tests and runtime state are excluded: the
// engine does not require them, and copying them would triple the fixture.
function installFixtureEngine(root) {
  const target = path.join(root, "coord");
  fs.mkdirSync(path.join(target, "board", "plans"), { recursive: true });
  fs.mkdirSync(path.join(target, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(target, ".runtime", "locks"), { recursive: true });
  for (const dir of ["scripts", "product", "docs"]) {
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
  for (const file of ["paths.js", "project.config.js", "engine-pin.json", "GOVERNANCE.md", "AGENTS.md", "TEMPLATE_SYNC_MANIFEST.json"]) {
    fs.cpSync(path.join(ENGINE_COORD, file), path.join(target, file));
  }
  return target;
}

function seedBoard(coordDir) {
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
            Description: "Fixture lifecycle ticket.",
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
  fs.writeFileSync(path.join(coordDir, "prompts", "tickets", `${TICKET}.md`), `# ${TICKET}\n\n## Assignment\nFixture.\n`);
  fs.writeFileSync(path.join(coordDir, "PLAN.md"), "");
  fs.writeFileSync(path.join(coordDir, "QUESTIONS.md"), "# Questions\n");
}

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-645-lifecycle-")));
  const coordDir = installFixtureEngine(root);
  seedBoard(coordDir);
  for (const repo of ["backend", "frontend"]) {
    const dir = path.join(root, repo);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main", "."]);
    fs.writeFileSync(path.join(dir, "README.md"), `${repo}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "seed"]);
  }
  git(root, ["init", "-q", "-b", "main", "."]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed"]);
  return { root, coordDir };
}

// --------------------------------------------------------------------------
// The harness stand-in: submit to the real hook FIRST, and only run the step
// if the hook permits it. This is what "with the candidate hook active" means
// outside the Claude Code process.
// --------------------------------------------------------------------------

const hookCalls = [];

function askHook(ws, payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    cwd: ws.root,
    encoding: "utf8",
    env: {
      ...process.env,
      COORD_CANONICAL_DIR: ws.coordDir,
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

function guardedRun(ws, command) {
  const gate = askHook(ws, { tool_name: "Bash", tool_input: { command } });
  assert.equal(gate.status, 0, `barrier BLOCKED a lifecycle command: ${command}\n${gate.stderr}`);
  const res = spawnSync("bash", ["-c", command], {
    cwd: ws.root,
    encoding: "utf8",
    env: { ...process.env, COORD_SESSION_ID: "coord645-fixture" },
  });
  assert.equal(res.status, 0, `lifecycle command failed: ${command}\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
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

function gov(ws, args) {
  return guardedRun(ws, `node ${JSON.stringify(path.join(ws.coordDir, "scripts", "governance.js"))} ${args}`);
}

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
  gov(ws, `reconcile --reason ${JSON.stringify("fixture genesis baseline")}`);
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
  guardedRun(ws, `git ${GIT.join(" ")} -C ${JSON.stringify(worktree)} add -A`);
  gov(ws, `commit ${TICKET} --message ${JSON.stringify("fix: fixture ticket work")}`);

  const branch = lock.branch;
  const subject = spawnSync("git", ["-C", worktree, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).stdout.trim();
  assert.equal(subject, "fix: fixture ticket work", "gov commit must produce a REAL git commit");
  const committed = spawnSync("git", ["-C", worktree, "show", "--name-only", "--pretty=", "HEAD"], { encoding: "utf8" }).stdout;
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
  gov(ws, `submit ${TICKET} --fill --pr ${JSON.stringify("local-review (no PR)")}`);

  assert.equal(boardRow(ws).row.Status, "review", "submit must move the board row to review");
  assert.equal(fs.existsSync(lockPath(ws)), false, "submit must RELEASE the governed lock");
  assert.deepEqual(boardRow(ws).board.pr_index[TICKET].map((e) => e.pr || e), ["local-review (no PR)"]);

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
