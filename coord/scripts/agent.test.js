const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function createAgentHarness(statusByTicket = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-agent-facade-"));
  const agentSourcePath = path.join(__dirname, "agent");
  const agentPath = path.join(tempDir, "agent");
  const govPath = path.join(tempDir, "gov");
  const logPath = path.join(tempDir, "gov-calls.ndjson");

  fs.copyFileSync(agentSourcePath, agentPath);
  fs.chmodSync(agentPath, 0o755);

  fs.writeFileSync(govPath, `#!/usr/bin/env node
const fs = require("fs");

const logPath = process.env.AGENT_FACADE_LOG_PATH;
const statusByTicket = JSON.parse(process.env.AGENT_FACADE_STATUS_MAP || "{}");
const [,, command, ...args] = process.argv;

if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ command, args }) + "\\n", "utf8");
}

if (command === "ticket") {
  const ticket = args[0];
  const status = statusByTicket[ticket];
  if (!status) {
    console.error(\`unknown test ticket \${ticket}\`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({
    ticket: {
      ID: ticket,
      Status: status,
    },
  }));
  process.exit(0);
}

if (command === "start" || command === "resume") {
  process.stdout.write(\`\${command} \${args[0]}\\n\`);
  process.exit(0);
}

if (command === "agentid") {
  if (args.includes("--assign")) {
    process.stdout.write(JSON.stringify({ handle: "testa01", needs_assignment: false }));
    process.exit(0);
  }
  const needsAssignment = process.env.AGENT_FACADE_NEEDS_ASSIGNMENT === "1";
  process.stdout.write(JSON.stringify({
    handle: needsAssignment ? null : "testa01",
    needs_assignment: needsAssignment,
  }));
  process.exit(0);
}

if (command === "doctor") {
  process.stdout.write("doctor report\\n");
  process.exit(Number(process.env.AGENT_FACADE_DOCTOR_EXIT || "0"));
}

if (command === "pick") {
  process.stdout.write(JSON.stringify({ recommended: ["GOV-052"] }));
  process.exit(0);
}

if (command === "explain") {
  process.stdout.write(JSON.stringify({
    ticket: {
      ID: args[0],
    },
  }));
  process.exit(0);
}

console.error(\`unexpected governance command: \${command}\`);
process.exit(70);
`, "utf8");
  fs.chmodSync(govPath, 0o755);

  return { tempDir, agentPath, logPath, statusByTicket };
}

function readGovCalls(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs.readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runAgent(agentPath, args, statusByTicket, logPath, extraEnv = {}) {
  return spawnSync(agentPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_FACADE_STATUS_MAP: JSON.stringify(statusByTicket),
      AGENT_FACADE_LOG_PATH: logPath,
      ...extraEnv,
    },
  });
}

test("agent do starts todo tickets via gov start without pre-claim side effects", () => {
  const harness = createAgentHarness({ "GOV-052": "todo" });
  const result = runAgent(harness.agentPath, ["do", "GOV-052"], harness.statusByTicket, harness.logPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "ticket", args: ["GOV-052"] },
    { command: "start", args: ["GOV-052"] },
    { command: "explain", args: ["GOV-052"] },
  ]);
});

test("agent do prepare resumes in-flight tickets via gov resume", () => {
  const harness = createAgentHarness({ "GOV-052": "doing" });
  const result = runAgent(harness.agentPath, ["do", "prepare", "GOV-052"], harness.statusByTicket, harness.logPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "ticket", args: ["GOV-052"] },
    { command: "resume", args: ["GOV-052"] },
    { command: "explain", args: ["GOV-052"] },
  ]);
});

test("agent resume does not pre-assign before gov resume", () => {
  const harness = createAgentHarness({ "GOV-052": "doing" });
  const result = runAgent(harness.agentPath, ["resume", "GOV-052"], harness.statusByTicket, harness.logPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "resume", args: ["GOV-052"] },
    { command: "explain", args: ["GOV-052"] },
  ]);
});

test("agent do prepare falls back to explain for non-runnable statuses", () => {
  const harness = createAgentHarness({ "GOV-043": "done" });
  const result = runAgent(harness.agentPath, ["do", "prepare", "GOV-043"], harness.statusByTicket, harness.logPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "ticket", args: ["GOV-043"] },
    { command: "explain", args: ["GOV-043"] },
  ]);
});

// COORD-478 — provider-neutral cold-start contract (`agent bootstrap`)

test("agent bootstrap on an unbound session assigns identity, checks health, recommends next", () => {
  const harness = createAgentHarness({});
  const result = runAgent(harness.agentPath, ["bootstrap"], harness.statusByTicket, harness.logPath, {
    AGENT_FACADE_NEEDS_ASSIGNMENT: "1",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "agentid", args: [] },
    { command: "agentid", args: ["--assign"] },
    { command: "doctor", args: [] },
    { command: "pick", args: ["--mode", "general", "--limit", "1"] },
  ]);
});

test("agent bootstrap on a bound session never re-assigns identity", () => {
  const harness = createAgentHarness({});
  const result = runAgent(harness.agentPath, ["bootstrap"], harness.statusByTicket, harness.logPath, {
    AGENT_FACADE_NEEDS_ASSIGNMENT: "0",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "agentid", args: [] },
    { command: "doctor", args: [] },
    { command: "pick", args: ["--mode", "general", "--limit", "1"] },
  ]);
});

test("agent bootstrap fails visibly (nonzero) when the health check fails, after still recommending", () => {
  const harness = createAgentHarness({});
  const result = runAgent(harness.agentPath, ["bootstrap"], harness.statusByTicket, harness.logPath, {
    AGENT_FACADE_NEEDS_ASSIGNMENT: "0",
    AGENT_FACADE_DOCTOR_EXIT: "3",
  });

  assert.equal(result.status, 3, "bootstrap must propagate the doctor failure");
  assert.match(result.stderr, /health check failed/);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "agentid", args: [] },
    { command: "doctor", args: [] },
    { command: "pick", args: ["--mode", "general", "--limit", "1"] },
  ]);
});

// GOV-070 — facade identity-write lint
//
// The facade at coord/scripts/agent dispatches to governance CLI verbs. It
// MUST NOT invoke identity-state-writing commands (claim, agentid --assign,
// agents register, takeover, lock-abandon, agent-rebind) because those
// manufacture handle/session churn ahead of the core lifecycle verb's
// decision. GOV-052 fixed one such instance in `agent do`; this lint exists
// to catch any future regression.
//
// The allow-list below names only commands whose identity-state effects are
// either read-only (ticket, explain, pick, doctor, counts) or gated by an
// explicit ticket-lifecycle verb decision (start, resume, submit, finalize,
// land, recover).
//
// COORD-478 exception: `agentid` is allowed ONLY inside the dedicated
// user-facing `bootstrap` verb — the explicit cold-start identity binder the
// GOV-070 rationale itself anticipated ("expose an explicit user-facing
// repair command"). The scoped lint below pins every `agentid` invocation to
// the bootstrap_command function body, so lifecycle verbs still cannot
// manufacture identity churn.
const FACADE_ALLOWED_GOV_COMMANDS = new Set([
  "ticket",
  "explain",
  "pick",
  "doctor",
  "counts",
  "start",
  "resume",
  "submit",
  "finalize",
  "land",
  "recover",
  "agentid",
]);

const FACADE_FORBIDDEN_GOV_COMMANDS = new Set([
  "claim",
  "agents",
  "takeover",
  "lock-abandon",
  "agent-rebind",
  "release-lock",
  "reconcile",
  "mark-done",
  "break-runtime-lock",
]);

function collectFacadeGovInvocations(source) {
  // Match bash invocations of the form `"$GOV" <command>` or `$GOV <command>`,
  // including lines that start the command after other shell tokens.
  const pattern = /"\$GOV"\s+([a-zA-Z][a-zA-Z0-9_-]*)/g;
  const invocations = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    invocations.push(match[1]);
  }
  return invocations;
}

test("GOV-070 facade lint: coord/scripts/agent only invokes allowed governance commands", () => {
  const facadeSource = fs.readFileSync(path.join(__dirname, "agent"), "utf8");
  const invocations = collectFacadeGovInvocations(facadeSource);

  assert.ok(invocations.length > 0, "facade should invoke at least one governance command");

  const unexpected = invocations.filter((cmd) => !FACADE_ALLOWED_GOV_COMMANDS.has(cmd));
  assert.deepEqual(
    unexpected,
    [],
    `facade is invoking governance commands outside the allow-list: ${unexpected.join(", ")}. ` +
    `If a new command must be dispatched from the facade, add it to FACADE_ALLOWED_GOV_COMMANDS ` +
    `only after confirming it is either read-only or gated by an explicit ticket-lifecycle verb.`
  );
});

test("GOV-070 facade lint: coord/scripts/agent never invokes identity-state-writing governance commands", () => {
  const facadeSource = fs.readFileSync(path.join(__dirname, "agent"), "utf8");
  const invocations = collectFacadeGovInvocations(facadeSource);

  const forbidden = invocations.filter((cmd) => FACADE_FORBIDDEN_GOV_COMMANDS.has(cmd));
  assert.deepEqual(
    forbidden,
    [],
    `facade is invoking identity-state-writing governance commands: ${forbidden.join(", ")}. ` +
    `These manufacture handle/session churn ahead of the core lifecycle verb's decision ` +
    `(see GOV-052 / GOV-070). Route identity mutations through the core verb that needs them, ` +
    `or expose an explicit user-facing repair command (e.g., agent recover).`
  );
});

test("GOV-070 facade lint: coord/scripts/agent never writes runtime identity files directly", () => {
  const facadeSource = fs.readFileSync(path.join(__dirname, "agent"), "utf8");
  const forbiddenPaths = [
    ".runtime/agents.json",
    ".runtime/agent_sessions.json",
    "agents.json",
    "agent_sessions.json",
    "session-owners/",
  ];

  const hits = forbiddenPaths.filter((p) => facadeSource.includes(p));
  assert.deepEqual(
    hits,
    [],
    `facade references canonical runtime identity files: ${hits.join(", ")}. ` +
    `Only coord/scripts/gov may read or write these files; the facade must delegate.`
  );
});

test("GOV-070 facade lint: collectFacadeGovInvocations catches forbidden and missed commands in synthetic input", () => {
  const clean = '"$GOV" start "$1"\n"$GOV" resume "$1"\n';
  assert.deepEqual(collectFacadeGovInvocations(clean), ["start", "resume"]);

  const dirty = '"$GOV" claim --owner claudea11\n"$GOV" explain "$1"\n';
  const calls = collectFacadeGovInvocations(dirty);
  assert.ok(calls.includes("claim"), "linter must surface forbidden claim invocation");
  assert.ok(calls.includes("explain"), "linter must also surface allowed invocations");
});

// COORD-478 — scoped identity lint + provider adapter smoke coverage

// Extract the body of a top-level bash function (`name() { ... }`) by brace
// counting. Used to pin `agentid` usage to the bootstrap verb only.
function extractBashFunctionBody(source, name) {
  const marker = `${name}() {`;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start + marker.length - 1; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

test("COORD-478 scoped lint: gov agentid is invoked ONLY inside bootstrap_command", () => {
  const facadeSource = fs.readFileSync(path.join(__dirname, "agent"), "utf8");
  const bootstrapBody = extractBashFunctionBody(facadeSource, "bootstrap_command");
  assert.ok(bootstrapBody, "facade must define bootstrap_command()");

  const outside = facadeSource.replace(bootstrapBody, "");
  assert.ok(
    !/"\$GOV"\s+agentid/.test(outside),
    "gov agentid must not be invoked outside bootstrap_command — lifecycle verbs must not manufacture identity churn (GOV-070)"
  );
  const insideCalls = collectFacadeGovInvocations(bootstrapBody);
  assert.ok(insideCalls.includes("agentid"), "bootstrap_command must bind identity via gov agentid");
});

test("COORD-478 scoped lint: extractBashFunctionBody isolates the right function in synthetic input", () => {
  const synthetic = 'a() {\n  "$GOV" claim\n}\n\nb() {\n  if [[ 1 ]]; then\n    "$GOV" agentid\n  fi\n}\n';
  const body = extractBashFunctionBody(synthetic, "b");
  assert.ok(body.includes("agentid"), "extracted body keeps its own invocations");
  assert.ok(!body.includes("claim"), "extracted body excludes other functions");
  assert.equal(extractBashFunctionBody(synthetic, "missing"), null);
});

// The three provider adapters (Claude slash wrappers, CODEX.md, GEMINI.md) and
// the shell path must all delegate cold-start to the SAME neutral contract:
// `coord/scripts/agent bootstrap`. No shipped wrapper may reference the
// never-implemented `gov whoami`.
const REPO_ROOT = path.join(__dirname, "..", "..");

function shippedWrapperFiles() {
  const files = [
    path.join(REPO_ROOT, "CLAUDE.md"),
    path.join(REPO_ROOT, "CODEX.md"),
    path.join(REPO_ROOT, "GEMINI.md"),
    path.join(REPO_ROOT, "AGENTS.md"),
  ];
  const commandsDir = path.join(REPO_ROOT, ".claude", "commands");
  for (const entry of fs.readdirSync(commandsDir)) {
    if (entry.endsWith(".md")) files.push(path.join(commandsDir, entry));
  }
  return files;
}

test("COORD-478 adapter smoke: no shipped wrapper references the unimplemented gov whoami", () => {
  const offenders = [];
  for (const file of shippedWrapperFiles()) {
    const body = fs.readFileSync(file, "utf8");
    if (/gov\s+whoami/.test(body)) offenders.push(path.relative(REPO_ROOT, file));
  }
  assert.deepEqual(offenders, [], `wrappers still reference gov whoami: ${offenders.join(", ")}`);
});

test("COORD-478 adapter smoke: Claude, Codex, and Gemini cold-start adapters call the neutral bootstrap contract", () => {
  const adapters = [
    path.join(REPO_ROOT, ".claude", "commands", "initiate.md"),
    path.join(REPO_ROOT, ".claude", "commands", "next.md"),
    path.join(REPO_ROOT, "CODEX.md"),
    path.join(REPO_ROOT, "GEMINI.md"),
  ];
  for (const file of adapters) {
    const body = fs.readFileSync(file, "utf8");
    assert.ok(
      body.includes("coord/scripts/agent bootstrap"),
      `${path.relative(REPO_ROOT, file)} must delegate cold-start to coord/scripts/agent bootstrap`
    );
  }
});

// Every `coord/scripts/gov <verb>` a shipped wrapper documents must be a verb
// the governance CLI actually dispatches (cli.js `case "<verb>":` labels), and
// every `coord/scripts/agent <verb>` must be dispatched by the facade. This is
// the executable form of the acceptance criterion "no shipped wrapper
// references an unimplemented command".
function knownGovVerbs() {
  const cliSource = fs.readFileSync(path.join(__dirname, "cli.js"), "utf8");
  const verbs = new Set();
  const pattern = /case "([a-z0-9-]+)":/g;
  let match;
  while ((match = pattern.exec(cliSource)) !== null) verbs.add(match[1]);
  return verbs;
}

function knownAgentVerbs() {
  const facadeSource = fs.readFileSync(path.join(__dirname, "agent"), "utf8");
  const mainBody = extractBashFunctionBody(facadeSource, "main");
  const verbs = new Set();
  const pattern = /^\s{4}([a-z-]+(?:\|[a-z-]+)*)\)/gm;
  let match;
  while ((match = pattern.exec(mainBody)) !== null) {
    for (const verb of match[1].split("|")) verbs.add(verb);
  }
  return verbs;
}

test("COORD-478 adapter smoke: every gov/agent verb referenced by shipped wrappers is implemented", () => {
  const govVerbs = knownGovVerbs();
  const agentVerbs = knownAgentVerbs();
  assert.ok(govVerbs.has("agentid") && govVerbs.has("start"), "gov verb extraction is sane");
  assert.ok(agentVerbs.has("bootstrap") && agentVerbs.has("do"), "agent verb extraction is sane");

  const problems = [];
  for (const file of shippedWrapperFiles()) {
    const body = fs.readFileSync(file, "utf8");
    for (const m of body.matchAll(/coord\/scripts\/gov\s+([a-z][a-z0-9-]*)/g)) {
      if (!govVerbs.has(m[1])) problems.push(`${path.relative(REPO_ROOT, file)}: gov ${m[1]}`);
    }
    for (const m of body.matchAll(/coord\/scripts\/agent\s+([a-z][a-z-]*)/g)) {
      if (!agentVerbs.has(m[1])) problems.push(`${path.relative(REPO_ROOT, file)}: agent ${m[1]}`);
    }
  }
  assert.deepEqual(problems, [], `wrappers reference unimplemented commands:\n${problems.join("\n")}`);
});
